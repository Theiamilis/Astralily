"""Short-lived device access sessions obtained with a single-use P-256 challenge."""
from __future__ import annotations

import base64
import hashlib
import secrets
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .device_registry import DeviceRegistryError
from .state_store import core_state_store


class DeviceSessions:
    def __init__(self, store):
        self.store = store
        with store.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS device_auth_challenges (
                    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, message TEXT NOT NULL,
                    generation REAL NOT NULL, expires_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS device_access_sessions (
                    token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL,
                    generation REAL NOT NULL, expires_at REAL NOT NULL);
            """)

    @staticmethod
    def _device(db, device_id):
        row = db.execute("SELECT * FROM paired_devices WHERE id=? AND revoked_at IS NULL", (device_id,)).fetchone()
        if row is None:
            raise DeviceRegistryError("Device is unavailable or revoked. Pair again.", 401)
        return row

    def challenge(self, device_id):
        now = time.time()
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = self._device(db, device_id)
            db.execute("DELETE FROM device_auth_challenges WHERE expires_at<=?", (now,))
            db.execute("DELETE FROM device_access_sessions WHERE expires_at<=?", (now,))
            per_device = db.execute("SELECT COUNT(*) FROM device_auth_challenges WHERE device_id=?", (device_id,)).fetchone()[0]
            if per_device >= 5 or db.execute("SELECT COUNT(*) FROM device_auth_challenges").fetchone()[0] >= 256:
                raise DeviceRegistryError("Too many outstanding authentication challenges.", 429)
            challenge_id = secrets.token_hex(16)
            message = f"lily-device-session-v1:{device_id}:{challenge_id}:{secrets.token_urlsafe(32)}"
            db.execute("INSERT INTO device_auth_challenges VALUES (?, ?, ?, ?, ?)",
                       (challenge_id, device_id, message, row["updated_at"], now + 60))
        return {"id": challenge_id, "message": message, "expires_at": now + 60}

    def exchange(self, challenge_id, signature):
        now = time.time()
        with self.store.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            challenge = db.execute("SELECT * FROM device_auth_challenges WHERE id=? AND expires_at>?",
                                   (challenge_id, now)).fetchone()
            if challenge is None:
                raise DeviceRegistryError("Invalid or expired authentication challenge.", 401)
            row = self._device(db, challenge["device_id"])
            if row["updated_at"] != challenge["generation"]:
                raise DeviceRegistryError("Device permissions changed. Authenticate again.", 401)
            try:
                key = serialization.load_der_public_key(base64.b64decode(row["public_key_spki_b64"]))
                key.verify(base64.b64decode(signature, validate=True), challenge["message"].encode(), ec.ECDSA(hashes.SHA256()))
            except (InvalidSignature, ValueError, TypeError) as exc:
                raise DeviceRegistryError("Invalid device signature.", 401) from exc
            db.execute("DELETE FROM device_auth_challenges WHERE id=?", (challenge_id,))
            if db.execute("SELECT COUNT(*) FROM device_access_sessions WHERE device_id=? AND expires_at>?",
                          (row["id"], now)).fetchone()[0] >= 32:
                raise DeviceRegistryError("Too many active device sessions. Retry after expiry.", 429)
            token = "lds_" + secrets.token_urlsafe(32)
            db.execute("INSERT INTO device_access_sessions VALUES (?, ?, ?, ?)",
                       (hashlib.sha256(token.encode()).hexdigest(), row["id"], row["updated_at"], now + 900))
            db.execute("UPDATE paired_devices SET last_seen_at=? WHERE id=?", (now, row["id"]))
        return {"access_token": token, "expires_at": now + 900, "device_id": row["id"]}

    def verify(self, token):
        with self.store.connection() as db:
            session = db.execute("SELECT * FROM device_access_sessions WHERE token_hash=? AND expires_at>?",
                                 (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
            if session is None:
                raise DeviceRegistryError("Device session expired or invalid.", 401)
            row = self._device(db, session["device_id"])
            if row["updated_at"] != session["generation"]:
                raise DeviceRegistryError("Device session was revoked or permissions changed.", 401)
            return dict(row)

    def authorize(self, token, method, path):
        device = self.verify(token)
        # Private conversations and owner actions are not yet isolated for household roles.
        if device["role"] != "owner":
            import json
            scopes = json.loads(device["scopes_json"])
            if method != "GET" or path != "/health" or "health.read" not in scopes:
                raise DeviceRegistryError("This device role cannot access owner data or actions.", 403)
        return device


device_sessions = DeviceSessions(core_state_store)
