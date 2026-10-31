"""Persistent client identities and owner-approved, single-use pairing requests.

Approved device keys can authenticate through device_sessions. Legacy owner
credentials remain a separate compatibility path and require migration/rotation.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import sqlite3
import time
from typing import Any
from uuid import uuid4

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .state_store import CoreStateStore, core_state_store


CLIENT_ROLES = frozenset({"owner", "resident", "guest", "dashboard"})
_SCOPE_PATTERN = re.compile(r"^[a-z][a-z0-9._:-]{0,95}$")
INVITATION_TTL_SECONDS = 120
REQUEST_TTL_SECONDS = 300


class DeviceRegistryError(ValueError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def _validated_role(role: str) -> str:
    value = str(role or "").strip().lower()
    if value not in CLIENT_ROLES:
        raise DeviceRegistryError("Unsupported device role.")
    return value


def _validated_scopes(scopes: list[str]) -> list[str]:
    if len(scopes) > 32:
        raise DeviceRegistryError("Too many device scopes.")
    result = list(dict.fromkeys(str(item or "").strip().lower() for item in scopes))
    if any(not _SCOPE_PATTERN.fullmatch(item) for item in result):
        raise DeviceRegistryError("Invalid device scope.")
    return result


def _validated_label(value: str, field: str) -> str:
    normalized = " ".join(str(value or "").split())
    if not normalized or len(normalized) > 80 or any(ord(char) < 32 for char in normalized):
        raise DeviceRegistryError(f"Invalid {field}.")
    return normalized


def _canonical_public_key(value: str) -> tuple[str, str]:
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) > 512:
            raise ValueError("Public key is too large.")
        key = serialization.load_der_public_key(raw)
        if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
            raise ValueError("Only ECDSA P-256 keys are supported.")
        canonical = key.public_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    except (ValueError, TypeError) as exc:
        raise DeviceRegistryError("A valid ECDSA P-256 public key is required.") from exc
    return base64.b64encode(canonical).decode("ascii"), hashlib.sha256(canonical).hexdigest()


def _device_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "platform": row["platform"],
        "role": row["role"],
        "scopes": json.loads(row["scopes_json"]),
        "key_fingerprint": row["key_fingerprint"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_seen_at": row["last_seen_at"],
        "revoked_at": row["revoked_at"],
    }


class DeviceRegistry:
    def __init__(self, store: CoreStateStore) -> None:
        self.store = store

    @staticmethod
    def _event(connection: sqlite3.Connection, device_id: str, action: str, actor: str, now: float) -> None:
        connection.execute(
            "INSERT INTO device_registry_events(device_id, action, actor, created_at) VALUES(?, ?, ?, ?)",
            (device_id, action, actor, now),
        )

    def list_devices(self) -> list[dict[str, Any]]:
        with self.store.connection() as connection:
            rows = connection.execute("SELECT * FROM paired_devices ORDER BY created_at DESC").fetchall()
        return [_device_payload(row) for row in rows]

    def history(self, device_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        bounded = max(1, min(int(limit), 200))
        with self.store.connection() as connection:
            if device_id:
                rows = connection.execute(
                    "SELECT id, device_id, action, actor, created_at FROM device_registry_events "
                    "WHERE device_id=? ORDER BY id DESC LIMIT ?", (device_id, bounded),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT id, device_id, action, actor, created_at FROM device_registry_events "
                    "ORDER BY id DESC LIMIT ?", (bounded,),
                ).fetchall()
        return [dict(row) for row in rows]

    def create_invitation(self, role: str, scopes: list[str]) -> dict[str, Any]:
        role = _validated_role(role)
        scopes = _validated_scopes(scopes)
        now = time.time()
        invitation_id = uuid4().hex
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
        expires_at = now + INVITATION_TTL_SECONDS
        with self.store.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            active = connection.execute(
                "SELECT COUNT(*) FROM pairing_invitations WHERE consumed_at IS NULL AND expires_at>?", (now,),
            ).fetchone()[0]
            if active >= 5:
                raise DeviceRegistryError("Too many active pairing invitations.", 429)
            connection.execute(
                "INSERT INTO pairing_invitations(id, token_hash, role, scopes_json, created_at, expires_at) "
                "VALUES(?, ?, ?, ?, ?, ?)",
                (invitation_id, token_hash, role, json.dumps(scopes), now, expires_at),
            )
        return {"id": invitation_id, "token": token, "role": role, "scopes": scopes, "expires_at": expires_at}

    def submit_request(self, token: str, name: str, platform: str, public_key_spki_b64: str) -> dict[str, Any]:
        name = _validated_label(name, "device name")
        platform = _validated_label(platform, "device platform")
        canonical_key, fingerprint = _canonical_public_key(public_key_spki_b64)
        token_hash = hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()
        now = time.time()
        request_id = uuid4().hex
        code = f"{secrets.randbelow(1_000_000):06d}"
        with self.store.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT id, revoked_at FROM paired_devices WHERE key_fingerprint=?", (fingerprint,),
            ).fetchone()
            if existing and existing["revoked_at"] is None:
                raise DeviceRegistryError("This device key is already enrolled.", 409)
            pending = connection.execute(
                "SELECT id FROM pairing_requests WHERE key_fingerprint=? AND status='pending' AND expires_at>?",
                (fingerprint, now),
            ).fetchone()
            if pending:
                raise DeviceRegistryError("This device key already has a pending request.", 409)
            invitation = connection.execute(
                "SELECT id FROM pairing_invitations WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?",
                (token_hash, now),
            ).fetchone()
            if invitation is None:
                raise DeviceRegistryError("Invalid or expired pairing invitation.", 404)
            consumed = connection.execute(
                "UPDATE pairing_invitations SET consumed_at=? WHERE id=? AND consumed_at IS NULL AND expires_at>?",
                (now, invitation["id"], now),
            )
            if consumed.rowcount != 1:
                raise DeviceRegistryError("Pairing invitation has already been used.", 409)
            connection.execute(
                "INSERT INTO pairing_requests(id, invitation_id, name, platform, public_key_spki_b64, "
                "key_fingerprint, verification_code, status, created_at, expires_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
                (request_id, invitation["id"], name, platform, canonical_key, fingerprint,
                 code, now, now + REQUEST_TTL_SECONDS),
            )
        return {"id": request_id, "verification_code": code, "status": "pending",
                "expires_at": now + REQUEST_TTL_SECONDS}

    def list_requests(self) -> list[dict[str, Any]]:
        now = time.time()
        with self.store.connection() as connection:
            rows = connection.execute(
                "SELECT r.id, r.name, r.platform, r.key_fingerprint, r.status, "
                "r.created_at, r.expires_at, r.decided_at, r.device_id, i.role, i.scopes_json "
                "FROM pairing_requests r JOIN pairing_invitations i ON i.id=r.invitation_id "
                "ORDER BY r.created_at DESC LIMIT 100",
            ).fetchall()
        return [
            {**{key: row[key] for key in ("id", "name", "platform", "key_fingerprint",
                                      "created_at", "expires_at", "decided_at", "device_id", "role")},
             "status": "expired" if row["status"] == "pending" and row["expires_at"] <= now else row["status"],
             "scopes": json.loads(row["scopes_json"])}
            for row in rows
        ]

    def request_status(self, request_id: str) -> dict[str, Any]:
        with self.store.connection() as connection:
            row = connection.execute(
                "SELECT status, expires_at, device_id FROM pairing_requests WHERE id=?", (request_id,),
            ).fetchone()
        if row is None:
            raise DeviceRegistryError("Pairing request not found.", 404)
        status = "expired" if row["status"] == "pending" and row["expires_at"] <= time.time() else row["status"]
        return {"status": status, "expires_at": row["expires_at"], "device_id": row["device_id"]}

    def decide_request(self, request_id: str, approve: bool, verification_code: str = "") -> dict[str, Any]:
        now = time.time()
        with self.store.connection() as connection:
            row = connection.execute(
                "SELECT r.*, i.role, i.scopes_json FROM pairing_requests r "
                "JOIN pairing_invitations i ON i.id=r.invitation_id WHERE r.id=?", (request_id,),
            ).fetchone()
            if row is None:
                raise DeviceRegistryError("Pairing request not found.", 404)
            if row["status"] != "pending" or row["expires_at"] <= now:
                raise DeviceRegistryError("Pairing request is no longer pending.", 409)
            if approve and not secrets.compare_digest(str(verification_code), row["verification_code"]):
                raise DeviceRegistryError("Verification code does not match the device.", 403)
            status = "approved" if approve else "denied"
            changed = connection.execute(
                "UPDATE pairing_requests SET status=?, decided_at=? WHERE id=? AND status='pending' AND expires_at>?",
                (status, now, request_id, now),
            )
            if changed.rowcount != 1:
                raise DeviceRegistryError("Pairing request was already decided.", 409)
            if not approve:
                return {"id": request_id, "status": status}
            existing = connection.execute(
                "SELECT id, revoked_at FROM paired_devices WHERE key_fingerprint=?", (row["key_fingerprint"],),
            ).fetchone()
            if existing and existing["revoked_at"] is None:
                raise DeviceRegistryError("This device key is already enrolled.", 409)
            if existing:
                device_id = existing["id"]
                connection.execute(
                    "UPDATE paired_devices SET name=?, platform=?, role=?, scopes_json=?, "
                    "public_key_spki_b64=?, updated_at=?, last_seen_at=NULL, revoked_at=NULL WHERE id=?",
                    (row["name"], row["platform"], row["role"], row["scopes_json"],
                     row["public_key_spki_b64"], now, device_id),
                )
                event_action = "reenrolled"
            else:
                device_id = uuid4().hex
                connection.execute(
                    "INSERT INTO paired_devices(id, name, platform, role, scopes_json, public_key_spki_b64, "
                    "key_fingerprint, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (device_id, row["name"], row["platform"], row["role"], row["scopes_json"],
                     row["public_key_spki_b64"], row["key_fingerprint"], now, now),
                )
                event_action = "enrolled"
            connection.execute("UPDATE pairing_requests SET device_id=? WHERE id=?", (device_id, request_id))
            self._event(connection, device_id, event_action, "owner", now)
        return {"id": request_id, "status": status, "device_id": device_id}

    def update_device(self, device_id: str, *, name: str | None = None,
                      role: str | None = None, scopes: list[str] | None = None) -> dict[str, Any]:
        now = time.time()
        with self.store.connection() as connection:
            row = connection.execute("SELECT * FROM paired_devices WHERE id=?", (device_id,)).fetchone()
            if row is None:
                raise DeviceRegistryError("Device not found.", 404)
            if row["revoked_at"] is not None:
                raise DeviceRegistryError("Revoked devices cannot be edited.", 409)
            resolved_name = _validated_label(name, "device name") if name is not None else row["name"]
            resolved_role = _validated_role(role) if role is not None else row["role"]
            resolved_scopes = _validated_scopes(scopes) if scopes is not None else json.loads(row["scopes_json"])
            connection.execute(
                "UPDATE paired_devices SET name=?, role=?, scopes_json=?, updated_at=? WHERE id=?",
                (resolved_name, resolved_role, json.dumps(resolved_scopes), now, device_id),
            )
            self._event(connection, device_id, "updated", "owner", now)
            updated = connection.execute("SELECT * FROM paired_devices WHERE id=?", (device_id,)).fetchone()
        return _device_payload(updated)

    def revoke_device(self, device_id: str) -> dict[str, Any]:
        now = time.time()
        with self.store.connection() as connection:
            row = connection.execute("SELECT * FROM paired_devices WHERE id=?", (device_id,)).fetchone()
            if row is None:
                raise DeviceRegistryError("Device not found.", 404)
            if row["revoked_at"] is not None:
                raise DeviceRegistryError("Device is already revoked.", 409)
            connection.execute(
                "UPDATE paired_devices SET revoked_at=?, updated_at=? WHERE id=?", (now, now, device_id),
            )
            self._event(connection, device_id, "revoked", "owner", now)
            updated = connection.execute("SELECT * FROM paired_devices WHERE id=?", (device_id,)).fetchone()
        return _device_payload(updated)

    def record_seen(self, device_id: str) -> bool:
        now = time.time()
        with self.store.connection() as connection:
            result = connection.execute(
                "UPDATE paired_devices SET last_seen_at=? WHERE id=? AND revoked_at IS NULL", (now, device_id),
            )
        return result.rowcount == 1


device_registry = DeviceRegistry(core_state_store)
