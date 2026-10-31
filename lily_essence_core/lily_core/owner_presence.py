from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict


OWNER_PRESENCE_STATUSES: Dict[str, Dict[str, Any]] = {
    "unknown": {
        "label": "Unknown",
        "note": "No recent owner activity signal is available. Do not guess what the owner is doing.",
        "ttl_minutes": None,
    },
    "available": {
        "label": "Available",
        "note": "Owner is available.",
        "ttl_minutes": None,
    },
    "busy": {
        "label": "Busy",
        "note": "Owner is busy. Keep replies concise and useful.",
        "ttl_minutes": 120,
    },
    "at_office": {
        "label": "At office",
        "note": "Owner is working. Keep replies concise and avoid noisy suggestions.",
        "ttl_minutes": 540,
    },
    "sleeping": {
        "label": "Sleeping",
        "note": "Owner may be resting. Keep replies calm and do not assume immediate attention.",
        "ttl_minutes": 480,
    },
    "gaming": {
        "label": "Gaming",
        "note": "Owner may be playing a game. Keep replies short and easy to act on.",
        "ttl_minutes": 240,
    },
    "away": {
        "label": "Away",
        "note": "Owner is away. Keep replies brief and hold non-urgent detail.",
        "ttl_minutes": 120,
    },
}

OWNER_PRESENCE_ALIASES = {
    "unknown": "unknown",
    "offline": "unknown",
    "normal": "available",
    "online": "available",
    "free": "available",
    "ada": "available",
    "aktif": "available",
    "sibuk": "busy",
    "busy": "busy",
    "meeting": "busy",
    "kerja": "at_office",
    "kantor": "at_office",
    "office": "at_office",
    "at office": "at_office",
    "tidur": "sleeping",
    "sleep": "sleeping",
    "sleeping": "sleeping",
    "istirahat": "sleeping",
    "game": "gaming",
    "gaming": "gaming",
    "main game": "gaming",
    "ranked": "gaming",
    "away": "away",
    "pergi": "away",
    "keluar": "away",
}

OWNER_PRESENCE_SOURCES = {
    "wa",
    "control_center",
    "private_realm",
    "mobile_realm",
    "hotkey",
    "system",
}


def _now(now: datetime | None = None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    if now.tzinfo is None:
        return now.replace(tzinfo=timezone.utc)
    return now.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _parse_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _clean_text(value: object, limit: int = 180) -> str:
    text = str(value or "").strip()
    text = " ".join(text.split())
    return text[:limit].strip()


def normalize_owner_presence_status(value: object) -> str:
    raw = _clean_text(value).lower().replace("-", "_").replace(" ", "_")
    if raw in OWNER_PRESENCE_STATUSES:
        return raw
    return OWNER_PRESENCE_ALIASES.get(raw.replace("_", " "), "")


def available_owner_presence(now: datetime | None = None) -> Dict[str, Any]:
    current = _now(now)
    defaults = OWNER_PRESENCE_STATUSES["available"]
    return {
        "status": "available",
        "label": defaults["label"],
        "note": defaults["note"],
        "source": "system",
        "updated_at": _iso(current),
        "expires_at": None,
        "active": False,
    }


def unknown_owner_presence(now: datetime | None = None) -> Dict[str, Any]:
    current = _now(now)
    defaults = OWNER_PRESENCE_STATUSES["unknown"]
    return {
        "status": "unknown",
        "label": defaults["label"],
        "note": defaults["note"],
        "source": "system",
        "updated_at": _iso(current),
        "expires_at": None,
        "active": False,
    }


def normalize_owner_presence(payload: Dict[str, Any] | None, now: datetime | None = None) -> Dict[str, Any]:
    current = _now(now)
    raw = dict(payload or {})
    status = normalize_owner_presence_status(raw.get("status"))
    custom_note = _clean_text(raw.get("note"))

    if not status and custom_note:
        status = "busy"
    if not status:
        status = "available"

    defaults = OWNER_PRESENCE_STATUSES[status]
    label = _clean_text(raw.get("label"), 48) or defaults["label"]
    note = custom_note or defaults["note"]
    source = _clean_text(raw.get("source"), 32) or "system"
    if source not in OWNER_PRESENCE_SOURCES:
        source = "system"

    updated_at = _parse_datetime(raw.get("updated_at")) or current
    expires_at = _parse_datetime(raw.get("expires_at"))
    ttl_value = raw.get("ttl_minutes")
    try:
        ttl_minutes = int(ttl_value) if ttl_value is not None else defaults["ttl_minutes"]
    except (TypeError, ValueError):
        ttl_minutes = defaults["ttl_minutes"]

    if status == "available":
        expires_at = None
    elif expires_at is None and ttl_minutes:
        expires_at = current + timedelta(minutes=max(1, ttl_minutes))

    return {
        "status": status,
        "label": label,
        "note": note,
        "source": source,
        "updated_at": _iso(updated_at),
        "expires_at": _iso(expires_at) if expires_at else None,
        "active": status not in {"available", "unknown"},
    }


def resolve_owner_presence(presence: Dict[str, Any] | None, now: datetime | None = None) -> Dict[str, Any]:
    normalized = normalize_owner_presence(presence, now=now)
    expires_at = _parse_datetime(normalized.get("expires_at"))
    if expires_at and expires_at <= _now(now):
        return unknown_owner_presence(now=now)
    return normalized


def format_owner_presence_prompt(presence: Dict[str, Any] | None) -> str:
    resolved = resolve_owner_presence(presence)
    if resolved["status"] == "available":
        return "Owner presence: available. No special activity constraint."
    if resolved["status"] == "unknown":
        return "Owner presence: unknown. Do not infer that the owner is sleeping, working, or away."

    label = resolved.get("label") or OWNER_PRESENCE_STATUSES[resolved["status"]]["label"]
    note = resolved.get("note") or OWNER_PRESENCE_STATUSES[resolved["status"]]["note"]
    return (
        f"Owner presence: {label} ({resolved['status']}). "
        f"Use this as light context, not a hard command. {note}"
    )
