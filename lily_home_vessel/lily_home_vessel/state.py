import threading
from datetime import datetime, timezone
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class HomeStateTracker:
    def __init__(self, offline_failure_threshold: int = 4) -> None:
        self.offline_failure_threshold = max(1, offline_failure_threshold)
        self._lock = threading.Lock()
        self._states: dict[str, dict[str, Any]] = {}

    def success(self, device_id: str, provider: str, state: dict[str, Any]) -> dict[str, Any]:
        payload = {
            **state,
            "device_id": device_id,
            "provider": provider,
            "online": True,
            "connection": "online",
            "last_seen": _utc_now(),
            "consecutive_failures": 0,
        }
        with self._lock:
            self._states[device_id] = payload
        return dict(payload)

    def failure(self, device_id: str, provider: str) -> dict[str, Any]:
        with self._lock:
            previous = self._states.get(device_id, {})
            failures = int(previous.get("consecutive_failures") or 0) + 1
            connection = "offline" if failures >= self.offline_failure_threshold else "reconnecting"
            payload = {
                **previous,
                "device_id": device_id,
                "provider": provider,
                "online": False,
                "connection": connection,
                "last_seen": previous.get("last_seen"),
                "consecutive_failures": failures,
            }
            self._states[device_id] = payload
        return dict(payload)
