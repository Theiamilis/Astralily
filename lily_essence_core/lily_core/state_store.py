import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from threading import Lock
from typing import Any

from .settings import settings


SCHEMA_VERSION = 2
LIVE_EVENT_TYPES = {"stream_stage", "tiktok_bridge", "live"}


class CoreStateStore:
    def __init__(self, path: Path, chat_retention_days: int = 180, live_retention_days: int = 7) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.chat_retention_seconds = max(1, chat_retention_days) * 86400
        self.live_retention_seconds = max(1, live_retention_days) * 86400
        self._lock = Lock()
        self._initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @contextmanager
    def connection(self):
        connection = self.connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._lock, self.connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS state_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    mode TEXT NOT NULL,
                    data_json TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS session_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_session_events_session
                    ON session_events(session_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS runtime_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_runtime_events_created
                    ON runtime_events(created_at);
                CREATE TABLE IF NOT EXISTS finance_drafts (
                    id TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS paired_devices (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    role TEXT NOT NULL,
                    scopes_json TEXT NOT NULL,
                    public_key_spki_b64 TEXT NOT NULL,
                    key_fingerprint TEXT NOT NULL UNIQUE,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    last_seen_at REAL,
                    revoked_at REAL
                );
                CREATE INDEX IF NOT EXISTS idx_paired_devices_created
                    ON paired_devices(created_at DESC);
                CREATE TABLE IF NOT EXISTS device_registry_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_device_registry_events_device
                    ON device_registry_events(device_id, id DESC);
                CREATE TABLE IF NOT EXISTS pairing_invitations (
                    id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    role TEXT NOT NULL,
                    scopes_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    consumed_at REAL
                );
                CREATE TABLE IF NOT EXISTS pairing_requests (
                    id TEXT PRIMARY KEY,
                    invitation_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    public_key_spki_b64 TEXT NOT NULL,
                    key_fingerprint TEXT NOT NULL,
                    verification_code TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    decided_at REAL,
                    device_id TEXT,
                    FOREIGN KEY (invitation_id) REFERENCES pairing_invitations(id)
                );
                CREATE INDEX IF NOT EXISTS idx_pairing_requests_status
                    ON pairing_requests(status, created_at DESC);
                """
            )
            connection.execute(
                "INSERT INTO state_meta(key, value) VALUES('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(SCHEMA_VERSION),),
            )
        self.cleanup()

    @staticmethod
    def _encode(payload: Any) -> str:
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)

    @staticmethod
    def _decode(value: str) -> Any:
        return json.loads(value)

    def schema_version(self) -> int:
        with self.connection() as connection:
            row = connection.execute("SELECT value FROM state_meta WHERE key='schema_version'").fetchone()
        return int(row["value"]) if row else 0

    def load_runtime_state(self, key: str) -> dict[str, Any] | None:
        normalized_key = str(key or "").strip()
        if not normalized_key:
            return None
        with self.connection() as connection:
            row = connection.execute("SELECT value FROM state_meta WHERE key=?", (normalized_key,)).fetchone()
        if not row:
            return None
        try:
            payload = self._decode(row["value"])
        except (json.JSONDecodeError, TypeError):
            return None
        return payload if isinstance(payload, dict) else None

    def save_runtime_state(self, key: str, payload: dict[str, Any]) -> None:
        normalized_key = str(key or "").strip()
        if not normalized_key:
            return
        with self._lock, self.connection() as connection:
            connection.execute(
                """
                INSERT INTO state_meta(key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
                """,
                (normalized_key, self._encode(payload)),
            )

    def save_session(self, session: dict[str, Any]) -> None:
        session_id = str(session.get("session_id") or "").strip()
        if not session_id:
            return
        updated_at = float(session.get("updated_at") or time.time())
        with self._lock, self.connection() as connection:
            connection.execute(
                """
                INSERT INTO sessions(session_id, mode, data_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    mode=excluded.mode,
                    data_json=excluded.data_json,
                    updated_at=excluded.updated_at
                """,
                (session_id, str(session.get("mode") or "owner_chat"), self._encode(session), updated_at),
            )

    def load_sessions(self) -> dict[str, dict[str, Any]]:
        cutoff = time.time() - self.chat_retention_seconds
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT session_id, data_json FROM sessions WHERE updated_at >= ?",
                (cutoff,),
            ).fetchall()
        result: dict[str, dict[str, Any]] = {}
        for row in rows:
            try:
                payload = self._decode(row["data_json"])
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(payload, dict):
                result[row["session_id"]] = payload
        return result

    def append_session_event(self, session_id: str, event_type: str, payload: dict[str, Any]) -> int:
        created_at = float(payload.get("created_at") or time.time())
        with self._lock, self.connection() as connection:
            cursor = connection.execute(
                "INSERT INTO session_events(session_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
                (session_id, event_type, self._encode(payload), created_at),
            )
            return int(cursor.lastrowid)

    def load_session_events(self, session_id: str, limit: int = 50) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT payload_json FROM session_events WHERE session_id=? ORDER BY id DESC LIMIT ?",
                (session_id, max(1, min(limit, 5000))),
            ).fetchall()
        events = []
        for row in rows:
            try:
                payload = self._decode(row["payload_json"])
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(payload, dict):
                events.append(payload)
        return events

    def clear_session_events(self, session_id: str) -> int:
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            return 0
        with self._lock, self.connection() as connection:
            cursor = connection.execute(
                "DELETE FROM session_events WHERE session_id=?",
                (normalized_session_id,),
            )
            return max(0, int(cursor.rowcount or 0))

    def pop_latest_session_event(self, session_id: str) -> dict[str, Any] | None:
        normalized_session_id = str(session_id or "").strip()
        if not normalized_session_id:
            return None
        with self._lock, self.connection() as connection:
            row = connection.execute(
                "SELECT id, payload_json FROM session_events "
                "WHERE session_id=? ORDER BY id DESC LIMIT 1",
                (normalized_session_id,),
            ).fetchone()
            if row is None:
                return None
            connection.execute("DELETE FROM session_events WHERE id=?", (int(row["id"]),))
        try:
            payload = self._decode(row["payload_json"])
        except (json.JSONDecodeError, TypeError):
            return None
        return payload if isinstance(payload, dict) else None

    def publish(self, event_type: str, payload: dict[str, Any]) -> int:
        created_at = time.time()
        with self._lock, self.connection() as connection:
            cursor = connection.execute(
                "INSERT INTO runtime_events(event_type, payload_json, created_at) VALUES (?, ?, ?)",
                (event_type, self._encode(payload), created_at),
            )
            return int(cursor.lastrowid)

    def recent_event_cursor(self, after_id: int, max_age_seconds: float = 60.0) -> int:
        """Bound a live consumer's replay cursor without deleting stored events."""
        cutoff = time.time() - max(0.0, max_age_seconds)
        with self.connection() as connection:
            row = connection.execute(
                "SELECT COALESCE(MAX(id), 0) AS latest, "
                "COALESCE(MAX(CASE WHEN created_at < ? THEN id END), 0) AS oldest "
                "FROM runtime_events",
                (cutoff,),
            ).fetchone()
        return min(int(row["latest"]), max(0, int(after_id), int(row["oldest"])))

    def replay(self, after_id: int, limit: int = 100) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT id, event_type, payload_json, created_at FROM runtime_events "
                "WHERE id > ? ORDER BY id ASC LIMIT ?",
                (max(0, after_id), max(1, min(limit, 500))),
            ).fetchall()
        events = []
        for row in rows:
            try:
                payload = self._decode(row["payload_json"])
            except (json.JSONDecodeError, TypeError):
                payload = {}
            events.append(
                {
                    "id": int(row["id"]),
                    "type": row["event_type"],
                    "payload": payload if isinstance(payload, dict) else {},
                    "created_at": float(row["created_at"]),
                }
            )
        return events

    def save_finance_draft(self, draft_id: str, payload: dict[str, Any], expires_at: float) -> None:
        with self._lock, self.connection() as connection:
            connection.execute(
                """
                INSERT INTO finance_drafts(id, data_json, expires_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    data_json=excluded.data_json,
                    expires_at=excluded.expires_at,
                    updated_at=excluded.updated_at
                """,
                (draft_id, self._encode(payload), expires_at, time.time()),
            )

    def load_finance_drafts(self) -> dict[str, dict[str, Any]]:
        now = time.time()
        with self.connection() as connection:
            rows = connection.execute(
                "SELECT id, data_json FROM finance_drafts WHERE expires_at > ?",
                (now,),
            ).fetchall()
        drafts: dict[str, dict[str, Any]] = {}
        for row in rows:
            try:
                payload = self._decode(row["data_json"])
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(payload, dict):
                drafts[row["id"]] = payload
        return drafts

    def delete_finance_draft(self, draft_id: str) -> None:
        with self._lock, self.connection() as connection:
            connection.execute("DELETE FROM finance_drafts WHERE id=?", (draft_id,))

    def cleanup(self) -> None:
        now = time.time()
        chat_cutoff = now - self.chat_retention_seconds
        live_cutoff = now - self.live_retention_seconds
        with self._lock, self.connection() as connection:
            placeholders = ",".join("?" for _ in LIVE_EVENT_TYPES)
            connection.execute(
                f"DELETE FROM session_events WHERE event_type IN ({placeholders}) AND created_at < ?",
                (*LIVE_EVENT_TYPES, live_cutoff),
            )
            connection.execute(
                f"DELETE FROM session_events WHERE event_type NOT IN ({placeholders}) AND created_at < ?",
                (*LIVE_EVENT_TYPES, chat_cutoff),
            )
            connection.execute("DELETE FROM runtime_events WHERE created_at < ?", (live_cutoff,))
            connection.execute("DELETE FROM sessions WHERE updated_at < ?", (chat_cutoff,))
            connection.execute("DELETE FROM finance_drafts WHERE expires_at <= ?", (now,))
            pairing_cutoff = now - 7 * 86400
            connection.execute("DELETE FROM pairing_requests WHERE expires_at < ?", (pairing_cutoff,))
            connection.execute(
                "DELETE FROM pairing_invitations WHERE expires_at < ? "
                "AND id NOT IN (SELECT invitation_id FROM pairing_requests)",
                (pairing_cutoff,),
            )


core_state_store = CoreStateStore(
    Path(settings.state_db_path),
    chat_retention_days=settings.chat_retention_days,
    live_retention_days=settings.live_event_retention_days,
)
