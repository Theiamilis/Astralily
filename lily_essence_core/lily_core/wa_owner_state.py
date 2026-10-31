import threading
import time
from typing import Any

from .state_store import CoreStateStore


STATE_KEY = "wa_owner_utility_v1"
ROUTE_HISTORY_LIMIT = 20
PINNED_MEMORY_LIMIT = 24


def _clean_text(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit].strip()


class WaOwnerState:
    def __init__(self, store: CoreStateStore) -> None:
        self.store = store
        self._lock = threading.Lock()
        self._state = self._load()

    @staticmethod
    def _default() -> dict[str, Any]:
        return {
            "version": 1,
            "last_owner_message": "",
            "last_owner_message_at": 0.0,
            "last_wa_profile": "",
            "route_history": [],
            "pinned_memory": [],
            "updated_at": 0.0,
        }

    def _load(self) -> dict[str, Any]:
        state = self._default()
        stored = self.store.load_runtime_state(STATE_KEY) or {}
        state.update(stored)
        state["route_history"] = [
            item for item in state.get("route_history", []) if isinstance(item, dict)
        ][-ROUTE_HISTORY_LIMIT:]
        state["pinned_memory"] = [
            _clean_text(item, 500)
            for item in state.get("pinned_memory", [])
            if _clean_text(item, 500)
        ][-PINNED_MEMORY_LIMIT:]
        return state

    def _save(self) -> None:
        self._state["updated_at"] = time.time()
        self.store.save_runtime_state(STATE_KEY, self._state)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                **self._state,
                "route_history": [dict(item) for item in self._state["route_history"]],
                "pinned_memory": list(self._state["pinned_memory"]),
            }

    def record_owner_message(self, message: str, wa_profile: str = "") -> dict[str, Any]:
        clean_message = _clean_text(message, 4000)
        if not clean_message or clean_message.startswith("/"):
            return self.snapshot()
        with self._lock:
            self._state["last_owner_message"] = clean_message
            self._state["last_owner_message_at"] = time.time()
            self._state["last_wa_profile"] = _clean_text(wa_profile, 24).lower()
            self._save()
        return self.snapshot()

    def replace_last_owner_message(self, message: str, wa_profile: str = "") -> None:
        with self._lock:
            self._state["last_owner_message"] = _clean_text(message, 4000)
            self._state["last_owner_message_at"] = time.time() if message else 0.0
            if wa_profile:
                self._state["last_wa_profile"] = _clean_text(wa_profile, 24).lower()
            self._save()

    def record_route(self, payload: dict[str, Any]) -> dict[str, Any]:
        route = {
            "message": _clean_text(payload.get("message"), 500),
            "source": _clean_text(payload.get("source"), 80) or "core_router",
            "intent": _clean_text(payload.get("intent"), 80) or "chat",
            "confidence": max(0.0, min(1.0, float(payload.get("confidence") or 0.0))),
            "reason": _clean_text(payload.get("reason"), 240),
            "wa_profile": _clean_text(payload.get("wa_profile"), 24).lower(),
            "created_at": time.time(),
        }
        with self._lock:
            history = self._state.setdefault("route_history", [])
            history.append(route)
            del history[:-ROUTE_HISTORY_LIMIT]
            self._save()
            return dict(route)

    def pin(self, text: str) -> dict[str, Any]:
        clean = _clean_text(text, 500)
        if not clean:
            raise ValueError("Pinned memory text is empty.")
        with self._lock:
            memories = self._state.setdefault("pinned_memory", [])
            lowered = clean.casefold()
            memories[:] = [item for item in memories if str(item).casefold() != lowered]
            memories.append(clean)
            del memories[:-PINNED_MEMORY_LIMIT]
            self._save()
            return {"index": len(memories), "text": clean}

    def unpin(self, index: int) -> dict[str, Any] | None:
        with self._lock:
            memories = self._state.setdefault("pinned_memory", [])
            resolved = int(index) - 1
            if resolved < 0 or resolved >= len(memories):
                return None
            removed = memories.pop(resolved)
            self._save()
            return {"index": int(index), "text": removed}

    def clear_transient(self) -> None:
        with self._lock:
            self._state["last_owner_message"] = ""
            self._state["last_owner_message_at"] = 0.0
            self._state["route_history"] = []
            self._save()

    def pinned_prompt(self) -> str:
        memories = self.snapshot().get("pinned_memory") or []
        if not memories:
            return ""
        return "Pinned owner memory (durable, owner-approved):\n" + "\n".join(
            f"- {item}" for item in memories
        )
