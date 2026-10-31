"""Owner-controlled storage and API for the separate Family sharing app."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.exceptions import InvalidSignature
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from .settings import settings
from .family_places import FamilyPlaceResolver


RESOURCE_ID = re.compile(r"^[a-f0-9]{32}$")
SMS_RETENTION_SECONDS = 24 * 60 * 60
DEVICE_SESSION_SECONDS = 30 * 24 * 60 * 60
PUBLIC_PAIRING_SECONDS = 30 * 60
INVITATION_SECONDS = 10 * 60
CHALLENGE_SECONDS = 60
router = APIRouter(tags=["family-sharing"])


def _require_owner(request: Request, x_lily_owner_token: str = Header(default="")) -> None:
    authorization = request.headers.get("authorization", "").strip()
    provided = authorization[7:].strip() if authorization.lower().startswith("bearer ") else x_lily_owner_token
    if not settings.owner_api_token:
        raise HTTPException(status_code=503, detail="Owner API authentication is not configured.")
    if not hmac.compare_digest(provided, settings.owner_api_token):
        raise HTTPException(status_code=401, detail="Owner authentication required.")


class FamilyServiceError(Exception):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _decode_signature(value: str) -> bytes:
    return base64.b64decode(value, validate=True)


def _key_fingerprint(public_key_spki_b64: str) -> str:
    try:
        der = base64.b64decode(public_key_spki_b64, validate=True)
        key = serialization.load_der_public_key(der)
    except (ValueError, TypeError) as exc:
        raise FamilyServiceError("Invalid device public key.") from exc
    if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
        raise FamilyServiceError("Family devices must use a P-256 signing key.")
    return hashlib.sha256(der).hexdigest()


class FamilyStore:
    def __init__(self, path: Path | str, encryption_key: str | None = None) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.encryption_key = encryption_key
        self._initialize()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        if os.name != "nt":
            self.path.chmod(0o600)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA secure_delete=ON")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @contextmanager
    def connection(self):
        db = self.connect()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def _initialize(self) -> None:
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS family_invitations (
                    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
                    created_at REAL NOT NULL, expires_at REAL NOT NULL,
                    used_at REAL, revoked_at REAL);
                CREATE TABLE IF NOT EXISTS family_pairing_requests (
                    id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL,
                    name TEXT NOT NULL, platform TEXT NOT NULL,
                    public_key_spki_b64 TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    status TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL,
                    decided_at REAL, decision_reason TEXT NOT NULL DEFAULT '', device_id TEXT);
                CREATE INDEX IF NOT EXISTS idx_family_pairing_status
                    ON family_pairing_requests(status, created_at DESC);
                CREATE TABLE IF NOT EXISTS family_devices (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
                    public_key_spki_b64 TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
                    created_at REAL NOT NULL, last_seen_at REAL, revoked_at REAL,
                    sharing_enabled INTEGER NOT NULL DEFAULT 0,
                    sms_permission INTEGER NOT NULL DEFAULT 0,
                    location_permission INTEGER NOT NULL DEFAULT 0,
                    battery_optimization_ignored INTEGER NOT NULL DEFAULT 0,
                    location_mode TEXT NOT NULL DEFAULT 'eco',
                    location_mode_expires_at REAL);
                CREATE TABLE IF NOT EXISTS family_sessions (
                    token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL,
                    created_at REAL NOT NULL, expires_at REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_family_sessions_device
                    ON family_sessions(device_id, expires_at);
                CREATE TABLE IF NOT EXISTS family_challenges (
                    id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
                    message TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS family_sms (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL,
                    event_id TEXT NOT NULL, received_at REAL NOT NULL,
                    encrypted_payload BLOB NOT NULL, uploaded_at REAL NOT NULL,
                    UNIQUE(device_id, event_id));
                CREATE INDEX IF NOT EXISTS idx_family_sms_device_time
                    ON family_sms(device_id, received_at DESC);
                CREATE TABLE IF NOT EXISTS family_locations (
                    device_id TEXT PRIMARY KEY, latitude REAL NOT NULL,
                    longitude REAL NOT NULL, accuracy_m REAL NOT NULL,
                    captured_at REAL NOT NULL, received_at REAL NOT NULL,
                    provider TEXT NOT NULL, mode TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS family_commands (
                    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, command_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL, status TEXT NOT NULL,
                    created_at REAL NOT NULL, updated_at REAL NOT NULL,
                    expires_at REAL NOT NULL, error TEXT NOT NULL DEFAULT '');
                CREATE INDEX IF NOT EXISTS idx_family_commands_device_status
                    ON family_commands(device_id, status, created_at);
            """)

    @staticmethod
    def _safe_device(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"], "name": row["name"], "platform": row["platform"],
            "created_at": row["created_at"], "last_seen_at": row["last_seen_at"],
            "revoked": row["revoked_at"] is not None,
            "sharing_enabled": bool(row["sharing_enabled"]),
            "sms_permission": bool(row["sms_permission"]),
            "location_permission": bool(row["location_permission"]),
            "battery_optimization_ignored": bool(row["battery_optimization_ignored"]),
            "location_mode": row["location_mode"],
            "location_mode_expires_at": row["location_mode_expires_at"],
        }

    def _fernet(self) -> Fernet:
        key = self.encryption_key or os.getenv("LILY_FAMILY_DATA_KEY", "").strip()
        if not key:
            raise FamilyServiceError("Family SMS encryption key is not configured.", 503)
        try:
            return Fernet(key.encode("ascii"))
        except (ValueError, UnicodeEncodeError) as exc:
            raise FamilyServiceError("Family SMS encryption key is invalid.", 503) from exc

    @staticmethod
    def _prune_sms(db: sqlite3.Connection, now: float) -> None:
        db.execute("DELETE FROM family_sms WHERE received_at < ?", (now - SMS_RETENTION_SECONDS,))
        db.execute("DELETE FROM family_sessions WHERE expires_at <= ?", (now,))
        db.execute("DELETE FROM family_challenges WHERE expires_at <= ?", (now,))
        db.execute("DELETE FROM family_invitations WHERE expires_at <= ? OR revoked_at IS NOT NULL", (now,))
        db.execute("DELETE FROM family_pairing_requests WHERE expires_at <= ? AND status IN ('pending','denied')", (now,))

    def prune_expired(self) -> int:
        now = time.time()
        with self.connection() as db:
            cursor = db.execute("DELETE FROM family_sms WHERE received_at < ?", (now - SMS_RETENTION_SECONDS,))
            self._prune_sms(db, now)
            return int(cursor.rowcount)

    def create_invitation(self) -> dict[str, Any]:
        now = time.time()
        invitation_id = secrets.token_hex(16)
        token = "fpi_" + secrets.token_urlsafe(32)
        with self.connection() as db:
            self._prune_sms(db, now)
            db.execute(
                "INSERT INTO family_invitations(id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (invitation_id, hashlib.sha256(token.encode()).hexdigest(), now, now + INVITATION_SECONDS),
            )
        return {"id": invitation_id, "invitation_token": token, "expires_at": now + INVITATION_SECONDS}

    def submit_pairing(self, invitation_token: str, name: str, platform: str, public_key_spki_b64: str) -> dict[str, Any]:
        now = time.time()
        if not name.strip() or len(name.strip()) > 80:
            raise FamilyServiceError("Device name must be between 1 and 80 characters.")
        if not platform.strip() or len(platform.strip()) > 80:
            raise FamilyServiceError("Platform must be between 1 and 80 characters.")
        fingerprint = _key_fingerprint(public_key_spki_b64)
        request_id = secrets.token_hex(16)
        token_hash = hashlib.sha256(invitation_token.encode()).hexdigest()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            self._prune_sms(db, now)
            invitation = db.execute(
                "SELECT * FROM family_invitations WHERE token_hash=? AND expires_at>? AND used_at IS NULL AND revoked_at IS NULL",
                (token_hash, now),
            ).fetchone()
            if invitation is None:
                raise FamilyServiceError("Invitation is invalid, expired, or already used.", 401)
            if db.execute("SELECT 1 FROM family_devices WHERE fingerprint=? AND revoked_at IS NULL", (fingerprint,)).fetchone():
                raise FamilyServiceError("This phone is already paired.", 409)
            db.execute("UPDATE family_invitations SET used_at=? WHERE id=?", (now, invitation["id"]))
            db.execute(
                "INSERT INTO family_pairing_requests(id, invitation_id, name, platform, public_key_spki_b64, fingerprint, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
                (request_id, invitation["id"], name.strip(), platform.strip(), public_key_spki_b64, fingerprint, now, now + PUBLIC_PAIRING_SECONDS),
            )
        return {"request_id": request_id, "status": "pending", "expires_at": now + PUBLIC_PAIRING_SECONDS}

    def pairing_status(self, request_id: str) -> dict[str, Any]:
        if not RESOURCE_ID.fullmatch(request_id):
            raise FamilyServiceError("Pairing request not found.", 404)
        now = time.time()
        with self.connection() as db:
            row = db.execute("SELECT * FROM family_pairing_requests WHERE id=?", (request_id,)).fetchone()
            if row is None or row["expires_at"] <= now:
                raise FamilyServiceError("Pairing request not found or expired.", 404)
            response: dict[str, Any] = {"request_id": request_id, "status": row["status"], "expires_at": row["expires_at"]}
            if row["status"] == "approved":
                response["device_id"] = row["device_id"]
            if row["status"] == "denied":
                response["reason"] = row["decision_reason"] or "Owner declined pairing."
            return response

    def list_pairing_requests(self) -> list[dict[str, Any]]:
        now = time.time()
        with self.connection() as db:
            rows = db.execute(
                "SELECT id, name, platform, status, created_at, expires_at FROM family_pairing_requests WHERE expires_at>? ORDER BY created_at DESC LIMIT 100",
                (now,),
            ).fetchall()
        return [dict(row) for row in rows]

    def decide_pairing(self, request_id: str, approve: bool) -> dict[str, Any]:
        now = time.time()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            request_row = db.execute(
                "SELECT * FROM family_pairing_requests WHERE id=? AND status='pending' AND expires_at>?",
                (request_id, now),
            ).fetchone()
            if request_row is None:
                raise FamilyServiceError("Pending pairing request not found or expired.", 404)
            if approve:
                if db.execute("SELECT 1 FROM family_devices WHERE fingerprint=? AND revoked_at IS NULL", (request_row["fingerprint"],)).fetchone():
                    raise FamilyServiceError("This phone is already paired.", 409)
                device_id = secrets.token_hex(16)
                db.execute(
                    "INSERT INTO family_devices(id, name, platform, public_key_spki_b64, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    (device_id, request_row["name"], request_row["platform"], request_row["public_key_spki_b64"], request_row["fingerprint"], now),
                )
                db.execute(
                    "UPDATE family_pairing_requests SET status='approved', decided_at=?, device_id=? WHERE id=?",
                    (now, device_id, request_id),
                )
                return {"request_id": request_id, "status": "approved", "device_id": device_id}
            db.execute(
                "UPDATE family_pairing_requests SET status='denied', decided_at=?, decision_reason='Owner declined pairing.' WHERE id=?",
                (now, request_id),
            )
        return {"request_id": request_id, "status": "denied"}

    def issue_challenge(self, device_id: str) -> dict[str, Any]:
        now = time.time()
        challenge_id = secrets.token_hex(16)
        message = f"lily-family-session-v1:{device_id}:{challenge_id}:{secrets.token_urlsafe(32)}"
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            device = db.execute("SELECT id FROM family_devices WHERE id=? AND revoked_at IS NULL", (device_id,)).fetchone()
            if device is None:
                raise FamilyServiceError("Paired Family device not found.", 401)
            active = db.execute("SELECT COUNT(*) FROM family_challenges WHERE device_id=? AND expires_at>?", (device_id, now)).fetchone()[0]
            if active >= 5:
                raise FamilyServiceError("Too many outstanding challenges.", 429)
            db.execute("INSERT INTO family_challenges VALUES (?, ?, ?, ?, ?)", (challenge_id, device_id, message, now, now + CHALLENGE_SECONDS))
        return {"challenge_id": challenge_id, "message": message, "expires_at": now + CHALLENGE_SECONDS}

    def exchange_challenge(self, challenge_id: str, signature_b64: str) -> dict[str, Any]:
        now = time.time()
        try:
            signature = _decode_signature(signature_b64)
        except (ValueError, TypeError) as exc:
            raise FamilyServiceError("Invalid device signature.", 401) from exc
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            challenge = db.execute("SELECT * FROM family_challenges WHERE id=? AND expires_at>?", (challenge_id, now)).fetchone()
            if challenge is None:
                raise FamilyServiceError("Challenge is invalid, expired, or already used.", 401)
            device = db.execute("SELECT * FROM family_devices WHERE id=? AND revoked_at IS NULL", (challenge["device_id"],)).fetchone()
            if device is None:
                raise FamilyServiceError("Paired Family device is revoked.", 401)
            try:
                key = serialization.load_der_public_key(base64.b64decode(device["public_key_spki_b64"], validate=True))
                if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
                    raise FamilyServiceError("Paired device key is invalid.", 401)
                key.verify(signature, challenge["message"].encode(), ec.ECDSA(hashes.SHA256()))
            except (InvalidSignature, ValueError, TypeError) as exc:
                raise FamilyServiceError("Invalid device signature.", 401) from exc
            db.execute("DELETE FROM family_challenges WHERE id=?", (challenge_id,))
            token = "fam_" + secrets.token_urlsafe(32)
            db.execute(
                "INSERT INTO family_sessions(token_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (hashlib.sha256(token.encode()).hexdigest(), device["id"], now, now + DEVICE_SESSION_SECONDS),
            )
            db.execute("UPDATE family_devices SET last_seen_at=? WHERE id=?", (now, device["id"]))
        return {"access_token": token, "expires_at": now + DEVICE_SESSION_SECONDS, "device_id": device["id"]}

    def authenticate(self, token: str, method: str, path: str) -> dict[str, Any]:
        now = time.time()
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self.connection() as db:
            row = db.execute(
                "SELECT d.* FROM family_sessions s JOIN family_devices d ON d.id=s.device_id WHERE s.token_hash=? AND s.expires_at>? AND d.revoked_at IS NULL",
                (token_hash, now),
            ).fetchone()
            if row is None:
                raise FamilyServiceError("Family session expired, invalid, or revoked.", 401)
            required_scope = None
            if method == "POST" and path == "/api/family/sms":
                required_scope = "sms.write"
            elif method == "POST" and path == "/api/family/location":
                required_scope = "location.write"
            elif method == "POST" and path == "/api/family/device/status":
                required_scope = "device.status"
            elif method == "GET" and path == "/api/family/commands":
                required_scope = "commands.read"
            elif method == "POST" and re.fullmatch(r"/api/family/commands/[a-f0-9]{32}/ack", path):
                required_scope = "commands.ack"
            if required_scope is None:
                raise FamilyServiceError("Family device role cannot access this route.", 403)
            return {"id": row["id"], "name": row["name"], "role": "family", "scope": required_scope}

    def report_status(self, device_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT id FROM family_devices WHERE id=? AND revoked_at IS NULL", (device_id,)).fetchone()
            if row is None:
                raise FamilyServiceError("Family device not found.", 404)
            if not payload["sharing_enabled"] or not payload["location_permission"]:
                mode = "paused"
            else:
                current = db.execute("SELECT location_mode, location_mode_expires_at, sharing_enabled, location_permission FROM family_devices WHERE id=?", (device_id,)).fetchone()
                mode = current["location_mode"]
                if not current["sharing_enabled"] or not current["location_permission"]:
                    mode = "eco"
                if mode == "live" and current["location_mode_expires_at"] and current["location_mode_expires_at"] <= now:
                    mode = "eco"
            db.execute(
                "UPDATE family_devices SET last_seen_at=?, sharing_enabled=?, sms_permission=?, location_permission=?, battery_optimization_ignored=?, location_mode=?, location_mode_expires_at=CASE WHEN ?='eco' OR ?='paused' THEN NULL ELSE location_mode_expires_at END WHERE id=?",
                (now, int(payload["sharing_enabled"]), int(payload["sms_permission"]), int(payload["location_permission"]), int(payload["battery_optimization_ignored"]), mode, mode, mode, device_id),
            )
            if not payload["sharing_enabled"]:
                db.execute("UPDATE family_commands SET status='failed', updated_at=?, error='Sharing paused on the phone.' WHERE device_id=? AND status IN ('pending','active')", (now, device_id))
        return {"device_id": device_id, "sharing_enabled": payload["sharing_enabled"], "updated_at": now}

    def upload_sms(self, device_id: str, event_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        if payload["received_at"] > now + 120:
            raise FamilyServiceError("SMS timestamp is in the future.")
        if payload["received_at"] < now - SMS_RETENTION_SECONDS:
            raise FamilyServiceError("SMS is older than the 24-hour retention window.", 410)
        fernet = self._fernet()
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        encrypted = fernet.encrypt(encoded)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            self._prune_sms(db, now)
            device = db.execute("SELECT sharing_enabled, sms_permission FROM family_devices WHERE id=? AND revoked_at IS NULL", (device_id,)).fetchone()
            if device is None:
                raise FamilyServiceError("Family device is unavailable.", 401)
            if not device["sharing_enabled"] or not device["sms_permission"]:
                raise FamilyServiceError("SMS sharing is paused or permission is missing.", 403)
            row = db.execute("SELECT id, received_at FROM family_sms WHERE device_id=? AND event_id=?", (device_id, event_id)).fetchone()
            duplicate = row is not None
            if row is None:
                db.execute(
                    "INSERT INTO family_sms(device_id, event_id, received_at, encrypted_payload, uploaded_at) VALUES (?, ?, ?, ?, ?)",
                    (device_id, event_id, payload["received_at"], encrypted, now),
                )
                row = db.execute("SELECT id, received_at FROM family_sms WHERE device_id=? AND event_id=?", (device_id, event_id)).fetchone()
        return {"id": str(row["id"]), "event_id": event_id, "received_at": row["received_at"], "duplicate": duplicate}

    def list_sms(self, device_id: str, limit: int = 50, before_id: int | None = None) -> dict[str, Any]:
        now = time.time()
        fernet = self._fernet()
        with self.connection() as db:
            self._prune_sms(db, now)
            device = db.execute("SELECT id, name, revoked_at FROM family_devices WHERE id=?", (device_id,)).fetchone()
            if device is None or device["revoked_at"] is not None:
                raise FamilyServiceError("Family device is unavailable.", 404)
            query = "SELECT id, event_id, received_at, encrypted_payload FROM family_sms WHERE device_id=?"
            params: list[Any] = [device_id]
            if before_id is not None:
                query += " AND id<?"
                params.append(before_id)
            query += " ORDER BY id DESC LIMIT ?"
            params.append(limit)
            rows = db.execute(query, params).fetchall()
        items = []
        for row in rows:
            try:
                payload = json.loads(fernet.decrypt(row["encrypted_payload"]).decode("utf-8"))
            except (InvalidToken, ValueError, UnicodeDecodeError) as exc:
                raise FamilyServiceError("Stored Family SMS could not be decrypted.", 500) from exc
            items.append({"id": row["id"], "event_id": row["event_id"], "received_at": row["received_at"], **payload})
        return {"device_id": device_id, "device_name": device["name"], "items": items}

    def store_location(self, device_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        now = time.time()
        if payload["captured_at"] > now + 120 or payload["captured_at"] < now - 24 * 60 * 60:
            raise FamilyServiceError("Location timestamp is outside the accepted freshness window.")
        with self.connection() as db:
            device = db.execute("SELECT sharing_enabled, location_permission, location_mode, location_mode_expires_at FROM family_devices WHERE id=? AND revoked_at IS NULL", (device_id,)).fetchone()
            if device is None:
                raise FamilyServiceError("Family device is unavailable.", 401)
            if not device["sharing_enabled"] or not device["location_permission"]:
                raise FamilyServiceError("Location sharing is paused or permission is missing.", 403)
            if device["location_mode"] == "paused":
                raise FamilyServiceError("Location sharing is paused on the phone.", 403)
            db.execute(
                "INSERT INTO family_locations(device_id, latitude, longitude, accuracy_m, captured_at, received_at, provider, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, accuracy_m=excluded.accuracy_m, captured_at=excluded.captured_at, received_at=excluded.received_at, provider=excluded.provider, mode=excluded.mode",
                (device_id, payload["latitude"], payload["longitude"], payload["accuracy_m"], payload["captured_at"], now, payload["provider"], device["location_mode"]),
            )
            db.execute("UPDATE family_devices SET last_seen_at=? WHERE id=?", (now, device_id))
        return {"device_id": device_id, "received_at": now}

    def list_devices(self) -> list[dict[str, Any]]:
        now = time.time()
        with self.connection() as db:
            rows = db.execute("SELECT * FROM family_devices ORDER BY created_at DESC").fetchall()
            statuses = [self._safe_device(row) for row in rows]
            for item in statuses:
                location = db.execute("SELECT captured_at, accuracy_m FROM family_locations WHERE device_id=?", (item["id"],)).fetchone()
                item["last_location_at"] = location["captured_at"] if location else None
                item["location_accuracy_m"] = location["accuracy_m"] if location else None
                item["online"] = bool(item["last_seen_at"] and now - item["last_seen_at"] < 20 * 60)
        return statuses

    def revoke_device(self, device_id: str) -> dict[str, Any]:
        now = time.time()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute("UPDATE family_devices SET revoked_at=?, sharing_enabled=0, location_mode='paused' WHERE id=? AND revoked_at IS NULL", (now, device_id)).rowcount
            if not changed:
                raise FamilyServiceError("Family device not found or already revoked.", 404)
            db.execute("DELETE FROM family_sessions WHERE device_id=?", (device_id,))
            db.execute("UPDATE family_commands SET status='failed', updated_at=?, error='Device access was revoked.' WHERE device_id=? AND status IN ('pending','active')", (now, device_id))
        return {"device_id": device_id, "revoked_at": now}

    def location(self, device_id: str) -> dict[str, Any]:
        now = time.time()
        with self.connection() as db:
            row = db.execute("SELECT d.name, d.revoked_at, l.* FROM family_devices d LEFT JOIN family_locations l ON l.device_id=d.id WHERE d.id=?", (device_id,)).fetchone()
        if row is None or row["revoked_at"] is not None:
            raise FamilyServiceError("Family device not found.", 404)
        if row["captured_at"] is None:
            return {"device_id": device_id, "device_name": row["name"], "location": None}
        captured = float(row["captured_at"])
        return {
            "device_id": device_id, "device_name": row["name"],
            "location": {"latitude": row["latitude"], "longitude": row["longitude"],
                         "accuracy_m": row["accuracy_m"], "captured_at": captured,
                         "received_at": row["received_at"], "provider": row["provider"],
                         "mode": row["mode"], "stale": now - captured > 20 * 60},
        }

    def create_location_mode_command(self, device_id: str, mode: str) -> dict[str, Any]:
        if mode not in {"eco", "live"}:
            raise FamilyServiceError("Location mode must be 'eco' or 'live'.")
        now = time.time()
        command_id = secrets.token_hex(16)
        payload = {"mode": mode, "duration_seconds": 900 if mode == "live" else 0}
        with self.connection() as db:
            device = db.execute("SELECT id, revoked_at, sharing_enabled, location_permission FROM family_devices WHERE id=?", (device_id,)).fetchone()
            if device is None or device["revoked_at"] is not None:
                raise FamilyServiceError("Family device not found or revoked.", 404)
            if mode == "live" and (not device["sharing_enabled"] or not device["location_permission"]):
                raise FamilyServiceError("Live mode requires sharing to be enabled and location permission granted on the phone.", 409)
            db.execute(
                "INSERT INTO family_commands(id, device_id, command_type, payload_json, status, created_at, updated_at, expires_at) VALUES (?, ?, 'set_location_mode', ?, 'pending', ?, ?, ?)",
                (command_id, device_id, json.dumps(payload), now, now, now + 30 * 60),
            )
        return {"id": command_id, "device_id": device_id, "type": "set_location_mode", "payload": payload,
                "status": "pending", "created_at": now, "updated_at": now, "expires_at": now + 30 * 60}

    def get_device_commands(self, device_id: str) -> list[dict[str, Any]]:
        now = time.time()
        with self.connection() as db:
            db.execute("UPDATE family_commands SET status='failed', updated_at=?, error='Command expired before the phone received it.' WHERE device_id=? AND status='pending' AND expires_at<=?", (now, device_id, now))
            rows = db.execute("SELECT * FROM family_commands WHERE device_id=? AND status='pending' AND expires_at>? ORDER BY created_at LIMIT 20", (device_id, now)).fetchall()
            db.execute("UPDATE family_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL", (now, device_id))
        return [{"id": row["id"], "type": row["command_type"], "payload": json.loads(row["payload_json"]),
                 "status": row["status"], "created_at": row["created_at"], "expires_at": row["expires_at"]} for row in rows]

    def acknowledge_command(self, device_id: str, command_id: str, status: str, error: str) -> dict[str, Any]:
        if status not in {"active", "completed", "failed"}:
            raise FamilyServiceError("Command status must be active, completed, or failed.")
        now = time.time()
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM family_commands WHERE id=? AND device_id=?", (command_id, device_id)).fetchone()
            if row is None:
                raise FamilyServiceError("Family command not found.", 404)
            if row["status"] not in {"pending", "active"}:
                return {"id": command_id, "status": row["status"], "updated_at": row["updated_at"]}
            if status == "active" and row["status"] != "pending":
                raise FamilyServiceError("Only pending commands can become active.", 409)
            if row["expires_at"] <= now and status == "active":
                db.execute("UPDATE family_commands SET status='failed', updated_at=?, error='Command expired.' WHERE id=?", (now, command_id))
                return {"id": command_id, "status": "failed", "updated_at": now}
            if status == "active" and row["command_type"] == "set_location_mode":
                payload = json.loads(row["payload_json"])
                mode = payload["mode"]
                device = db.execute("SELECT sharing_enabled, location_permission FROM family_devices WHERE id=? AND revoked_at IS NULL", (device_id,)).fetchone()
                if device is None or not device["sharing_enabled"] or (mode == "live" and not device["location_permission"]):
                    db.execute("UPDATE family_commands SET status='failed', updated_at=?, error='Sharing or location permission is unavailable.' WHERE id=?", (now, command_id))
                    return {"id": command_id, "status": "failed", "updated_at": now}
                if mode == "live":
                    active_until = now + min(900, max(1, int(payload.get("duration_seconds", 900))))
                else:
                    active_until = None
                db.execute("UPDATE family_devices SET location_mode=?, location_mode_expires_at=? WHERE id=?", (mode, active_until, device_id))
                if active_until is not None:
                    db.execute("UPDATE family_commands SET expires_at=? WHERE id=?", (active_until, command_id))
                db.execute("UPDATE family_commands SET status='completed', updated_at=?, error='Superseded by a newer location mode.' WHERE device_id=? AND command_type='set_location_mode' AND status='active' AND id<>?", (now, device_id, command_id))
            elif status == "completed" and row["command_type"] == "set_location_mode":
                payload = json.loads(row["payload_json"])
                if payload.get("mode") == "eco":
                    db.execute("UPDATE family_devices SET location_mode='eco', location_mode_expires_at=NULL WHERE id=?", (device_id,))
            db.execute("UPDATE family_commands SET status=?, updated_at=?, error=? WHERE id=?", (status, now, error[:240], command_id))
            if status in {"completed", "failed"} and row["command_type"] == "set_location_mode":
                payload = json.loads(row["payload_json"])
                if payload.get("mode") == "live":
                    db.execute("UPDATE family_devices SET location_mode='eco', location_mode_expires_at=NULL WHERE id=? AND location_mode='live' AND location_mode_expires_at<=?", (device_id, now))
        return {"id": command_id, "status": status, "updated_at": now}

    def list_commands(self, device_id: str) -> list[dict[str, Any]]:
        with self.connection() as db:
            now = time.time()
            expired = db.execute(
                "SELECT id, device_id FROM family_commands WHERE command_type='set_location_mode' AND status='active' AND expires_at<=?",
                (now,),
            ).fetchall()
            for command in expired:
                db.execute("UPDATE family_commands SET status='completed', updated_at=?, error='Live mode expired.' WHERE id=?", (now, command["id"]))
                db.execute("UPDATE family_devices SET location_mode='eco', location_mode_expires_at=NULL WHERE id=? AND location_mode='live'", (command["device_id"],))
            rows = db.execute("SELECT * FROM family_commands WHERE device_id=? ORDER BY created_at DESC LIMIT 100", (device_id,)).fetchall()
        return [{"id": row["id"], "type": row["command_type"], "payload": json.loads(row["payload_json"]),
                 "status": row["status"], "created_at": row["created_at"], "updated_at": row["updated_at"],
                 "expires_at": row["expires_at"], "error": row["error"]} for row in rows]


_data_path = Path(settings.state_db_path).parent / "family_state.sqlite3"
family_store = FamilyStore(_data_path)


class PairingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    invitation_token: str = Field(min_length=36, max_length=96)
    name: str = Field(min_length=1, max_length=80)
    platform: str = Field(min_length=1, max_length=80)
    public_key_spki_b64: str = Field(min_length=80, max_length=1024)


class ChallengeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class ExchangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    challenge_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    signature_b64: str = Field(min_length=80, max_length=256)


class SmsUpload(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    event_id: str = Field(min_length=16, max_length=64, pattern=r"^[a-f0-9-]{16,64}$")
    sender: str = Field(min_length=1, max_length=80)
    body: str = Field(min_length=1, max_length=10000)
    received_at: float = Field(gt=0)
    subscription_id: int | None = Field(default=None, ge=0)
    sim_slot: int | None = Field(default=None, ge=0, le=4)


class LocationUpload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_m: float = Field(ge=0, le=100000)
    captured_at: float = Field(gt=0)
    provider: str = Field(default="fused", max_length=32, pattern=r"^[a-zA-Z0-9_-]*$")


class DeviceStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sharing_enabled: bool
    sms_permission: bool
    location_permission: bool
    battery_optimization_ignored: bool = False


class CommandAck(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    status: str = Field(pattern=r"^(active|completed|failed)$")
    error: str = Field(default="", max_length=240)


class LocationModeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: str = Field(pattern=r"^(eco|live)$")


def _run(action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except FamilyServiceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def _device_id(request: Request) -> str:
    principal = getattr(request.state, "family_principal", None)
    if not isinstance(principal, dict) or not principal.get("id"):
        raise HTTPException(status_code=401, detail="Family device session is required.")
    return str(principal["id"])


@router.post("/api/family/pairing/requests")
def submit_pairing(payload: PairingRequest):
    return _run(family_store.submit_pairing, **payload.model_dump())


@router.get("/api/family/pairing/requests/{request_id}/status")
def pairing_status(request_id: str):
    return _run(family_store.pairing_status, request_id)


@router.post("/api/family/sessions/challenge")
def family_challenge(payload: ChallengeRequest):
    return _run(family_store.issue_challenge, payload.device_id)


@router.post("/api/family/sessions/exchange")
def family_exchange(payload: ExchangeRequest):
    return _run(family_store.exchange_challenge, payload.challenge_id, payload.signature_b64)


@router.post("/api/family/device/status")
def update_device_status(payload: DeviceStatus, request: Request):
    return _run(family_store.report_status, _device_id(request), payload.model_dump())


@router.post("/api/family/sms")
def upload_sms(
    payload: SmsUpload,
    request: Request,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
):
    if not idempotency_key or not secrets.compare_digest(idempotency_key, payload.event_id):
        raise HTTPException(status_code=400, detail="Idempotency-Key must match the SMS event ID.")
    return _run(family_store.upload_sms, _device_id(request), payload.event_id, payload.model_dump())


@router.post("/api/family/location")
def upload_location(payload: LocationUpload, request: Request):
    return _run(family_store.store_location, _device_id(request), payload.model_dump())


@router.get("/api/family/commands")
def get_commands(request: Request):
    return {"commands": family_store.get_device_commands(_device_id(request))}


@router.post("/api/family/commands/{command_id}/ack")
def acknowledge_command(command_id: str, payload: CommandAck, request: Request):
    return _run(family_store.acknowledge_command, _device_id(request), command_id, payload.status, payload.error)


@router.post("/api/owner/family/invitations", dependencies=[Depends(_require_owner)])
def create_invitation():
    return family_store.create_invitation()


@router.get("/api/owner/family/pairing/requests", dependencies=[Depends(_require_owner)])
def list_pairing_requests():
    return {"requests": family_store.list_pairing_requests()}


@router.post("/api/owner/family/pairing/requests/{request_id}/approve", dependencies=[Depends(_require_owner)])
def approve_pairing(request_id: str):
    return _run(family_store.decide_pairing, request_id, True)


@router.post("/api/owner/family/pairing/requests/{request_id}/deny", dependencies=[Depends(_require_owner)])
def deny_pairing(request_id: str):
    return _run(family_store.decide_pairing, request_id, False)


@router.get("/api/owner/family/devices", dependencies=[Depends(_require_owner)])
def list_family_devices():
    return {"devices": family_store.list_devices()}


@router.delete("/api/owner/family/devices/{device_id}", dependencies=[Depends(_require_owner)])
def revoke_family_device(device_id: str):
    result = _run(family_store.revoke_device, device_id)
    family_place_resolver.forget(device_id)
    return result


@router.get("/api/owner/family/devices/{device_id}/sms", dependencies=[Depends(_require_owner)])
def list_family_sms(device_id: str, limit: int = Query(default=50, ge=1, le=100), before_id: int | None = Query(default=None, ge=1)):
    return _run(family_store.list_sms, device_id, limit, before_id)


@router.get("/api/owner/family/devices/{device_id}/location", dependencies=[Depends(_require_owner)])
def get_family_location(device_id: str):
    return _run(family_store.location, device_id)


family_place_resolver = FamilyPlaceResolver(family_store.path)


@router.get("/api/owner/family/devices/{device_id}/place", dependencies=[Depends(_require_owner)])
def get_family_place(device_id: str):
    point = _run(family_store.location, device_id)
    place = family_place_resolver.resolve(device_id, point["location"])
    # Discard an enrichment if sharing was revoked or the point changed during the lookup.
    current = _run(family_store.location, device_id)
    current_stamp = (current["location"] or {}).get("captured_at")
    if current_stamp != place["captured_at"]:
        return {"device_id": device_id, "label": None, "status": "waiting", "captured_at": current_stamp, "source": "geoapify"}
    return {"device_id": device_id, **place}


@router.post("/api/owner/family/devices/{device_id}/location-mode", dependencies=[Depends(_require_owner)])
def request_location_mode(device_id: str, payload: LocationModeRequest):
    return _run(family_store.create_location_mode_command, device_id, payload.mode)


@router.get("/api/owner/family/devices/{device_id}/commands", dependencies=[Depends(_require_owner)])
def list_family_commands(device_id: str):
    return _run(family_store.list_commands, device_id)
