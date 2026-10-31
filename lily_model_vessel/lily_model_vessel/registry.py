from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import stat
import tempfile
import time
import zipfile
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any


SEMANTIC_OPTIONS = (
    "Love",
    "Soft Love",
    "Blush",
    "Shy",
    "Sparkle Mood",
    "Gloomy",
    "Crying",
    "Sweat",
    "Angry",
)
ASSIGNMENT_TARGETS = ("global", "control_center", "stream_stage", "private_realm")


class ModelRegistryError(RuntimeError):
    def __init__(self, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def _slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return normalized[:48] or "live2d-model"


def _guess_semantic(name: str) -> str | None:
    value = re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
    guesses = (
        (("soft love", "gentle love", "heart soft"), "Soft Love"),
        (("love", "heart", "lovey"), "Love"),
        (("blush", "red face", "tere"), "Blush"),
        (("shy", "embarrass", "hazukashi"), "Shy"),
        (("sparkle", "happy", "smile", "joy", "kirakira"), "Sparkle Mood"),
        (("gloom", "sad", "down", "sulk"), "Gloomy"),
        (("cry", "tear", "sob"), "Crying"),
        (("sweat", "nervous", "panic"), "Sweat"),
        (("angry", "mad", "rage", "ikari"), "Angry"),
    )
    for needles, semantic in guesses:
        if any(needle in value for needle in needles):
            return semantic
    return None


def _read_manifest(folder: Path) -> tuple[Path, dict[str, Any]]:
    manifests = sorted(folder.rglob("*.model3.json"), key=lambda path: (len(path.parts), str(path).lower()))
    if not manifests:
        raise ModelRegistryError("The archive does not contain a .model3.json manifest.")
    manifest_path = manifests[0]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise ModelRegistryError(f"The Live2D manifest is invalid: {error}") from error
    refs = manifest.get("FileReferences")
    if not isinstance(refs, dict):
        raise ModelRegistryError("The Live2D manifest has no FileReferences object.")
    model_root = manifest_path.parent.resolve()

    def referenced_file(raw_path: object) -> Path | None:
        if not isinstance(raw_path, str) or not raw_path.strip():
            return None
        relative = PurePosixPath(raw_path.replace("\\", "/"))
        if relative.is_absolute() or ".." in relative.parts:
            return None
        candidate = (model_root / Path(*relative.parts)).resolve()
        if candidate != model_root and model_root not in candidate.parents:
            return None
        return candidate

    moc_path = refs.get("Moc")
    moc_file = referenced_file(moc_path)
    if moc_file is None or not moc_file.is_file():
        raise ModelRegistryError("The manifest does not reference an existing .moc3 file.")
    textures = refs.get("Textures", [])
    if not isinstance(textures, list) or not textures:
        raise ModelRegistryError("The manifest does not reference any textures.")
    missing = [item for item in textures if (referenced_file(item) is None or not referenced_file(item).is_file())]
    if missing:
        raise ModelRegistryError("One or more textures referenced by the manifest are missing.")
    return manifest_path, manifest


def _manifest_expressions(manifest: dict[str, Any]) -> list[dict[str, str | None]]:
    refs = manifest.get("FileReferences", {})
    raw = refs.get("Expressions", []) if isinstance(refs, dict) else []
    found: list[dict[str, str | None]] = []
    if not isinstance(raw, list):
        return found
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        name = str(item.get("Name") or f"Expression {index + 1}").strip()
        file_name = str(item.get("File") or "").strip()
        if name and file_name:
            found.append(
                {
                    "raw_name": name,
                    "file_name": file_name,
                    "display_name": name,
                    "semantic_key": _guess_semantic(name),
                }
            )
    return found


class ModelRegistry:
    def __init__(
        self,
        asset_root: Path,
        database_path: Path,
        max_unpacked_bytes: int = 768 * 1024 * 1024,
        max_archive_files: int = 4096,
    ) -> None:
        self.asset_root = asset_root
        self.database_path = database_path
        self.max_unpacked_bytes = max(1, max_unpacked_bytes)
        self.max_archive_files = max(1, max_archive_files)
        self.asset_root.mkdir(parents=True, exist_ok=True)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_database()
        self.scan_assets()
        self._normalize_semantic_duplicates()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _init_database(self) -> None:
        with self._connection() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS models (
                    model_id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    model_json_path TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS expressions (
                    model_id TEXT NOT NULL REFERENCES models(model_id) ON DELETE CASCADE,
                    raw_name TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    semantic_key TEXT,
                    default_active INTEGER NOT NULL DEFAULT 0,
                    sort_order INTEGER NOT NULL,
                    PRIMARY KEY (model_id, raw_name)
                );
                CREATE TABLE IF NOT EXISTS assignments (
                    target TEXT PRIMARY KEY,
                    model_id TEXT NOT NULL REFERENCES models(model_id) ON DELETE RESTRICT,
                    updated_at REAL NOT NULL
                );
                """
            )
            expression_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(expressions)").fetchall()
            }
            if "default_active" not in expression_columns:
                db.execute(
                    "ALTER TABLE expressions ADD COLUMN default_active INTEGER NOT NULL DEFAULT 0"
                )

    def _unique_id(self, preferred: str) -> str:
        base = _slug(preferred)
        candidate = base
        suffix = 2
        while (self.asset_root / candidate).exists() or self.get_model(candidate, required=False):
            candidate = f"{base}-{suffix}"
            suffix += 1
        return candidate

    def _hash_manifest(self, manifest_path: Path) -> str:
        return hashlib.sha256(manifest_path.read_bytes()).hexdigest()

    def _register_folder(self, folder: Path, model_id: str | None = None, display_name: str | None = None) -> dict[str, Any]:
        manifest_path, manifest = _read_manifest(folder)
        model_id = model_id or _slug(folder.name)
        relative_manifest = manifest_path.relative_to(folder).as_posix()
        now = time.time()
        expressions = _manifest_expressions(manifest)
        with self._connection() as db:
            db.execute(
                "INSERT OR IGNORE INTO models(model_id, display_name, model_json_path, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (model_id, (display_name or folder.name).strip(), relative_manifest, self._hash_manifest(manifest_path), now, now),
            )
            for index, expression in enumerate(expressions):
                db.execute(
                    """INSERT OR IGNORE INTO expressions(model_id, raw_name, file_name, display_name, semantic_key, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        model_id,
                        expression["raw_name"],
                        expression["file_name"],
                        expression["display_name"],
                        expression["semantic_key"],
                        index,
                    ),
                )
        return self.get_model(model_id)

    def scan_assets(self) -> None:
        for folder in sorted(self.asset_root.iterdir()):
            if not folder.is_dir() or folder.name.startswith("."):
                continue
            try:
                self._register_folder(folder)
            except ModelRegistryError:
                continue

    def _normalize_semantic_duplicates(self) -> None:
        with self._connection() as db:
            duplicates = db.execute(
                """SELECT model_id, semantic_key FROM expressions
                WHERE semantic_key IS NOT NULL AND semantic_key != ''
                GROUP BY model_id, semantic_key HAVING COUNT(*) > 1"""
            ).fetchall()
            for duplicate in duplicates:
                rows = db.execute(
                    "SELECT raw_name FROM expressions WHERE model_id = ? AND semantic_key = ? ORDER BY sort_order",
                    (duplicate["model_id"], duplicate["semantic_key"]),
                ).fetchall()
                semantic_normalized = re.sub(r"[^a-z0-9]+", "", duplicate["semantic_key"].lower())
                keeper = next(
                    (
                        row["raw_name"]
                        for row in rows
                        if re.sub(r"[^a-z0-9]+", "", row["raw_name"].lower()) == semantic_normalized
                    ),
                    rows[0]["raw_name"],
                )
                db.execute(
                    "UPDATE expressions SET semantic_key = NULL WHERE model_id = ? AND semantic_key = ? AND raw_name != ?",
                    (duplicate["model_id"], duplicate["semantic_key"], keeper),
                )

    def list_models(self) -> list[dict[str, Any]]:
        with self._connection() as db:
            rows = db.execute("SELECT * FROM models ORDER BY lower(display_name), model_id").fetchall()
        return [self._model_payload(row) for row in rows]

    def get_model(self, model_id: str, required: bool = True) -> dict[str, Any] | None:
        with self._connection() as db:
            row = db.execute("SELECT * FROM models WHERE model_id = ?", (model_id,)).fetchone()
        if row is None:
            if required:
                raise ModelRegistryError("Live2D model was not found.", 404)
            return None
        return self._model_payload(row)

    def _model_payload(self, row: sqlite3.Row) -> dict[str, Any]:
        model_id = str(row["model_id"])
        with self._connection() as db:
            expressions = db.execute(
                "SELECT raw_name, file_name, display_name, semantic_key, default_active, sort_order FROM expressions WHERE model_id = ? ORDER BY sort_order, raw_name",
                (model_id,),
            ).fetchall()
            assigned = [item["target"] for item in db.execute("SELECT target FROM assignments WHERE model_id = ? ORDER BY target", (model_id,))]
        expression_payloads = []
        for expression in expressions:
            payload = dict(expression)
            payload["default_active"] = bool(payload["default_active"])
            expression_payloads.append(payload)
        return {
            "model_id": model_id,
            "display_name": row["display_name"],
            "model_json_path": row["model_json_path"],
            "content_hash": row["content_hash"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "expressions": expression_payloads,
            "assigned_targets": assigned,
        }

    def install_zip(self, archive_bytes: bytes, source_name: str, display_name: str | None = None) -> dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="lily-model-") as temp_dir:
            staging = Path(temp_dir) / "unpacked"
            staging.mkdir()
            archive_path = Path(temp_dir) / "upload.zip"
            archive_path.write_bytes(archive_bytes)
            try:
                with zipfile.ZipFile(archive_path) as archive:
                    members = archive.infolist()
                    if len(members) > self.max_archive_files:
                        raise ModelRegistryError("The archive contains too many files.")
                    total_size = sum(member.file_size for member in members)
                    if total_size > self.max_unpacked_bytes:
                        raise ModelRegistryError("The unpacked model is larger than the configured limit.")
                    for member in members:
                        path = PurePosixPath(member.filename.replace("\\", "/"))
                        if path.is_absolute() or ".." in path.parts:
                            raise ModelRegistryError("The archive contains an unsafe path.")
                        if stat.S_ISLNK(member.external_attr >> 16):
                            raise ModelRegistryError("Symbolic links are not allowed in model archives.")
                    archive.extractall(staging)
            except zipfile.BadZipFile as error:
                raise ModelRegistryError("The uploaded file is not a valid ZIP archive.") from error

            manifest_path, _manifest = _read_manifest(staging)
            model_root = manifest_path.parent
            preferred = display_name or Path(source_name).stem or model_root.name
            model_id = self._unique_id(preferred)
            destination = self.asset_root / model_id
            shutil.copytree(model_root, destination)
            try:
                return self._register_folder(destination, model_id, display_name or Path(source_name).stem)
            except Exception:
                shutil.rmtree(destination, ignore_errors=True)
                raise

    def rename_model(self, model_id: str, display_name: str) -> dict[str, Any]:
        self.get_model(model_id)
        now = time.time()
        with self._connection() as db:
            db.execute("UPDATE models SET display_name = ?, updated_at = ? WHERE model_id = ?", (display_name.strip(), now, model_id))
        return self.get_model(model_id)

    def update_expressions(self, model_id: str, updates: list[dict[str, Any]]) -> dict[str, Any]:
        self.get_model(model_id)
        allowed = set(SEMANTIC_OPTIONS)
        with self._connection() as db:
            existing = {row["raw_name"] for row in db.execute("SELECT raw_name FROM expressions WHERE model_id = ?", (model_id,))}
            requested = {item["raw_name"] for item in updates}
            if not requested.issubset(existing):
                raise ModelRegistryError("One or more expression identifiers do not belong to this model.")
            used_semantics: set[str] = set()
            for item in updates:
                semantic = item.get("semantic_key") or None
                if semantic and semantic not in allowed:
                    raise ModelRegistryError(f"Unsupported expression meaning: {semantic}")
                if semantic and semantic in used_semantics:
                    raise ModelRegistryError(f"Expression meaning '{semantic}' is assigned more than once.")
                if semantic:
                    used_semantics.add(semantic)
                db.execute(
                    "UPDATE expressions SET display_name = ?, semantic_key = ?, default_active = ? WHERE model_id = ? AND raw_name = ?",
                    (
                        item["display_name"].strip(),
                        semantic,
                        int(bool(item.get("default_active", False))),
                        model_id,
                        item["raw_name"],
                    ),
                )
            db.execute("UPDATE models SET updated_at = ? WHERE model_id = ?", (time.time(), model_id))
        return self.get_model(model_id)

    def assign(self, target: str, model_id: str) -> dict[str, Any]:
        if target not in ASSIGNMENT_TARGETS:
            raise ModelRegistryError("Unknown model assignment target.")
        self.get_model(model_id)
        with self._connection() as db:
            db.execute(
                "INSERT INTO assignments(target, model_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(target) DO UPDATE SET model_id = excluded.model_id, updated_at = excluded.updated_at",
                (target, model_id, time.time()),
            )
        return self.resolve_assignment(target)

    def assignments(self) -> dict[str, str]:
        with self._connection() as db:
            return {row["target"]: row["model_id"] for row in db.execute("SELECT target, model_id FROM assignments")}

    def resolve_assignment(self, target: str) -> dict[str, Any]:
        if target not in ASSIGNMENT_TARGETS:
            raise ModelRegistryError("Unknown model assignment target.")
        assignments = self.assignments()
        model_id = assignments.get(target) or assignments.get("global")
        if not model_id:
            models = self.list_models()
            if not models:
                raise ModelRegistryError("No Live2D model is installed.", 404)
            model_id = models[0]["model_id"]
        payload = self.get_model(model_id)
        payload["requested_target"] = target
        payload["resolved_from"] = target if target in assignments else ("global" if "global" in assignments else "first_available")
        payload["expression_options"] = [item["semantic_key"] for item in payload["expressions"] if item["semantic_key"]]
        payload["expression_map"] = {
            item["semantic_key"]: item["raw_name"] for item in payload["expressions"] if item["semantic_key"]
        }
        return payload

    def delete_model(self, model_id: str) -> None:
        model = self.get_model(model_id)
        if model["assigned_targets"]:
            raise ModelRegistryError("Remove this model from all active assignments before deleting it.", 409)
        folder = (self.asset_root / model_id).resolve()
        if folder.parent != self.asset_root:
            raise ModelRegistryError("Refusing to delete an unsafe model path.", 500)
        with self._connection() as db:
            db.execute("DELETE FROM models WHERE model_id = ?", (model_id,))
        shutil.rmtree(folder, ignore_errors=True)
