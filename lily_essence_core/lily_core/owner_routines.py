from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from threading import RLock
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from .state_store import CoreStateStore


ROUTINE_STATE_KEY = "owner_routines_v1"
DELIVERY_LEASE_SECONDS = 120
DELIVERY_MAX_ATTEMPTS = 4
DELIVERY_RETRY_SECONDS = (60, 180, 600, 1800)
DELIVERY_RETENTION_DAYS = 14
DEFAULT_ROUTINES = (
    {
        "id": "morning_brief",
        "label": "Morning brief",
        "time": "08:15",
        "days": [0, 1, 2, 3, 4, 5, 6],
        "enabled": True,
        "message": "Pagi. Cek agenda dan tiga prioritas hari ini dulu, biar harimu nggak lari ke mana-mana.",
    },
    {
        "id": "work_check",
        "label": "Work check",
        "time": "10:00",
        "days": [0, 1, 2, 3, 4],
        "enabled": True,
        "message": "Udah mulai fokus kerja? Pilih satu hal paling penting dan beresin itu dulu.",
    },
    {
        "id": "evening_recap",
        "label": "Evening recap",
        "time": "18:30",
        "days": [0, 1, 2, 3, 4, 5, 6],
        "enabled": True,
        "message": "Sebelum malam keburu habis, cek task yang selesai dan sisakan yang memang perlu dibawa besok.",
    },
    {
        "id": "sleep_reminder",
        "label": "Sleep reminder",
        "time": "22:45",
        "days": [0, 1, 2, 3, 4, 5, 6],
        "enabled": True,
        "message": "Udah malam. Rapikan yang terakhir, minum dulu, lalu kasih badanmu waktu buat istirahat.",
    },
)


class OwnerRoutineEngine:
    def __init__(self, store: CoreStateStore, timezone_name: str = "Asia/Jakarta") -> None:
        self.store = store
        try:
            self.timezone = ZoneInfo(timezone_name)
        except Exception:
            self.timezone = timezone(timedelta(hours=7), name="Asia/Jakarta")
        self._lock = RLock()
        self.state = self._load()

    @staticmethod
    def _parse_datetime(value: object) -> datetime | None:
        if not isinstance(value, str) or not value.strip():
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed

    def _load(self) -> dict[str, Any]:
        stored = self.store.load_runtime_state(ROUTINE_STATE_KEY) or {}
        stored_items = {
            str(item.get("id") or ""): item
            for item in stored.get("items", [])
            if isinstance(item, dict)
        }
        items = []
        for default in DEFAULT_ROUTINES:
            merged = {**default, **stored_items.get(default["id"], {})}
            merged["enabled"] = bool(merged.get("enabled", True))
            items.append(merged)
        deliveries = {
            str(key): dict(value)
            for key, value in (stored.get("deliveries") or {}).items()
            if isinstance(value, dict)
        }
        for claim_key, claim in (stored.get("claims") or {}).items():
            claim_data = claim if isinstance(claim, dict) else {}
            routine_id, _, local_date = str(claim_key).rpartition(":")
            if not routine_id or not local_date:
                continue
            delivery_id = f"routine:{routine_id}:{local_date}"
            deliveries.setdefault(
                delivery_id,
                {
                    "id": delivery_id,
                    "routine_id": routine_id,
                    "local_date": local_date,
                    "profile": str(claim_data.get("profile") or "public"),
                    "status": "sent",
                    "attempts": 1,
                    "created_at": str(claim_data.get("claimed_at") or ""),
                    "updated_at": str(claim_data.get("claimed_at") or ""),
                    "sent_at": str(claim_data.get("claimed_at") or ""),
                    "last_error": "",
                },
            )
        return {
            "enabled": bool(stored.get("enabled", True)),
            "items": items,
            "deliveries": deliveries,
            "updated_at": str(stored.get("updated_at") or ""),
        }

    def _save(self) -> None:
        self.state["updated_at"] = datetime.now(self.timezone).isoformat()
        self.store.save_runtime_state(ROUTINE_STATE_KEY, self.state)

    def snapshot(self, now: datetime | None = None) -> dict[str, Any]:
        with self._lock:
            current = (now or datetime.now(self.timezone)).astimezone(self.timezone)
            items = deepcopy(self.state["items"])
            upcoming = []
            for day_offset in range(8):
                candidate_day = current + timedelta(days=day_offset)
                for item in items:
                    if not item["enabled"] or candidate_day.weekday() not in item["days"]:
                        continue
                    hour, minute = [int(value) for value in str(item["time"]).split(":", 1)]
                    candidate = candidate_day.replace(hour=hour, minute=minute, second=0, microsecond=0)
                    if candidate >= current:
                        upcoming.append((candidate, item["id"]))

            recent = sorted(
                (
                    {
                        key: deepcopy(value)
                        for key, value in delivery.items()
                        if key != "lease_token"
                    }
                    for delivery in self.state["deliveries"].values()
                ),
                key=lambda value: str(value.get("updated_at") or value.get("created_at") or ""),
                reverse=True,
            )[:12]
            counts = {status: 0 for status in ("pending", "leased", "failed", "sent", "abandoned")}
            for delivery in self.state["deliveries"].values():
                status = str(delivery.get("status") or "pending")
                counts[status] = counts.get(status, 0) + 1
            return {
                "ok": True,
                "enabled": bool(self.state["enabled"]),
                "timezone": str(self.timezone),
                "items": items,
                "next_routine_id": min(upcoming)[1] if upcoming else None,
                "next_routine_at": min(upcoming)[0].isoformat() if upcoming else None,
                "delivery_summary": counts,
                "recent_deliveries": recent,
                "updated_at": self.state.get("updated_at") or None,
            }

    def set_enabled(self, routine_id: str, enabled: bool) -> dict[str, Any]:
        with self._lock:
            normalized = str(routine_id or "").strip().lower()
            for item in self.state["items"]:
                if item["id"] == normalized:
                    item["enabled"] = bool(enabled)
                    self._save()
                    return self.snapshot()
            raise KeyError(normalized)

    def set_mLily-Voice-Host_enabled(self, enabled: bool) -> dict[str, Any]:
        with self._lock:
            self.state["enabled"] = bool(enabled)
            self._save()
            return self.snapshot()

    def _prune_deliveries(self, current: datetime) -> None:
        cutoff = current - timedelta(days=DELIVERY_RETENTION_DAYS)
        self.state["deliveries"] = {
            key: value
            for key, value in self.state["deliveries"].items()
            if (self._parse_datetime(value.get("updated_at") or value.get("created_at")) or current) >= cutoff
        }

    def _ensure_due_delivery(self, current: datetime) -> None:
        local_date = current.date().isoformat()
        current_minutes = current.hour * 60 + current.minute
        for item in self.state["items"]:
            if not item["enabled"] or current.weekday() not in item["days"]:
                continue
            hour, minute = [int(value) for value in str(item["time"]).split(":", 1)]
            elapsed = current_minutes - (hour * 60 + minute)
            if not 0 <= elapsed <= 90:
                continue
            delivery_id = f"routine:{item['id']}:{local_date}"
            if delivery_id in self.state["deliveries"]:
                continue
            scheduled_at = current.replace(hour=hour, minute=minute, second=0, microsecond=0)
            self.state["deliveries"][delivery_id] = {
                "id": delivery_id,
                "routine_id": item["id"],
                "local_date": local_date,
                "scheduled_at": scheduled_at.isoformat(),
                "expires_at": (scheduled_at + timedelta(minutes=90)).isoformat(),
                "text": item["message"],
                "status": "pending",
                "attempts": 0,
                "created_at": current.isoformat(),
                "updated_at": current.isoformat(),
                "next_attempt_at": current.isoformat(),
                "last_error": "",
            }

    def _release_expired_leases(self, current: datetime) -> None:
        for delivery in self.state["deliveries"].values():
            if delivery.get("status") != "leased":
                continue
            lease_expires = self._parse_datetime(delivery.get("lease_expires_at"))
            if lease_expires and lease_expires > current:
                continue
            delivery["status"] = "failed"
            delivery["last_error"] = "Delivery lease expired before acknowledgement."
            delivery["next_attempt_at"] = current.isoformat()
            delivery["updated_at"] = current.isoformat()

    def claim_due(self, profile: str, now: datetime | None = None) -> dict[str, Any]:
        with self._lock:
            current = (now or datetime.now(self.timezone)).astimezone(self.timezone)
            if not self.state["enabled"]:
                return {"ok": True, "due": False, "reason": "disabled"}

            self._prune_deliveries(current)
            self._ensure_due_delivery(current)
            self._release_expired_leases(current)
            normalized_profile = str(profile or "public").strip().lower()
            for delivery in sorted(
                self.state["deliveries"].values(),
                key=lambda value: str(value.get("scheduled_at") or value.get("created_at") or ""),
            ):
                expires_at = self._parse_datetime(delivery.get("expires_at"))
                if expires_at and expires_at < current:
                    if delivery.get("status") not in {"sent", "abandoned"}:
                        delivery["status"] = "abandoned"
                        delivery["last_error"] = "Delivery window expired before completion."
                        delivery["updated_at"] = current.isoformat()
                    continue
                status = str(delivery.get("status") or "pending")
                if status not in {"pending", "failed"}:
                    continue
                attempts = max(0, int(delivery.get("attempts") or 0))
                if attempts >= DELIVERY_MAX_ATTEMPTS:
                    delivery["status"] = "abandoned"
                    delivery["updated_at"] = current.isoformat()
                    continue
                next_attempt = self._parse_datetime(delivery.get("next_attempt_at"))
                if next_attempt and next_attempt > current:
                    continue
                lease_token = uuid4().hex
                delivery.update(
                    {
                        "status": "leased",
                        "profile": normalized_profile,
                        "attempts": attempts + 1,
                        "lease_token": lease_token,
                        "leased_at": current.isoformat(),
                        "lease_expires_at": (current + timedelta(seconds=DELIVERY_LEASE_SECONDS)).isoformat(),
                        "updated_at": current.isoformat(),
                    }
                )
                self._save()
                routine = next(
                    (item for item in self.state["items"] if item["id"] == delivery["routine_id"]),
                    {"id": delivery["routine_id"], "label": delivery["routine_id"]},
                )
                return {
                    "ok": True,
                    "due": True,
                    "routine": deepcopy(routine),
                    "text": delivery["text"],
                    "delivery": deepcopy(delivery),
                    "lease_token": lease_token,
                }
            self._save()
            return {"ok": True, "due": False, "reason": "nothing_due"}

    def acknowledge_delivery(
        self,
        delivery_id: str,
        lease_token: str,
        success: bool,
        profile: str,
        error: str = "",
        now: datetime | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            current = (now or datetime.now(self.timezone)).astimezone(self.timezone)
            normalized_id = str(delivery_id or "").strip()
            delivery = self.state["deliveries"].get(normalized_id)
            if not delivery:
                raise KeyError(normalized_id)
            if delivery.get("status") == "sent":
                return {"ok": True, "accepted": True, "delivery": deepcopy(delivery)}
            if str(delivery.get("lease_token") or "") != str(lease_token or ""):
                return {"ok": True, "accepted": False, "reason": "stale_lease"}

            delivery["profile"] = str(profile or delivery.get("profile") or "public").strip().lower()
            delivery["updated_at"] = current.isoformat()
            delivery["lease_token"] = ""
            delivery["lease_expires_at"] = None
            if success:
                delivery["status"] = "sent"
                delivery["sent_at"] = current.isoformat()
                delivery["last_error"] = ""
                delivery["next_attempt_at"] = None
            else:
                attempts = max(1, int(delivery.get("attempts") or 1))
                delivery["last_error"] = " ".join(str(error or "Delivery failed.").split())[:240]
                if attempts >= DELIVERY_MAX_ATTEMPTS:
                    delivery["status"] = "abandoned"
                    delivery["next_attempt_at"] = None
                else:
                    retry_seconds = DELIVERY_RETRY_SECONDS[min(attempts - 1, len(DELIVERY_RETRY_SECONDS) - 1)]
                    delivery["status"] = "failed"
                    delivery["next_attempt_at"] = (current + timedelta(seconds=retry_seconds)).isoformat()
            self._save()
            return {"ok": True, "accepted": True, "delivery": deepcopy(delivery)}
