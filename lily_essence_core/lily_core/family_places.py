"""Optional owner-only area labels; retain only each device's latest lookup in memory."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from collections import OrderedDict
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _fetch_geoapify(params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    request = Request("https://api.geoapify.com/v1/geocode/reverse?" + urlencode(params), headers={"User-Agent": "LilyFamilyPlaces/1.0"})
    # urllib has no request-URL INFO logger; errors are handled without their text below.
    try:
        with build_opener(_NoRedirect()).open(request, timeout=2.5) as response:
            payload = response.read(65537)
            if len(payload) > 65536:
                raise ValueError("Area response exceeded its limit.")
            return response.status, json.loads(payload)
    except HTTPError as error:
        try:
            return error.code, {}
        finally:
            error.close()


class FamilyPlaceResolver:
    def __init__(self, budget_path: Path, *, fetch=None):
        self.budget_path = budget_path
        self.fetch = fetch or _fetch_geoapify
        self._lock = threading.Lock()
        self._latest: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._last_request = 0.0
        self._busy = False

    def _reserve_credit(self) -> bool:
        try:
            cap = min(2000, max(0, int(os.getenv("LILY_FAMILY_GEOCODE_DAILY_LIMIT", "2000"))))
        except ValueError:
            cap = 2000
        day = datetime.now(timezone.utc).date().isoformat()
        with closing(sqlite3.connect(self.budget_path, timeout=3)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS family_geocode_usage (day TEXT PRIMARY KEY, used INTEGER NOT NULL)")
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM family_geocode_usage WHERE day <> ?", (day,))
            db.execute("INSERT OR IGNORE INTO family_geocode_usage(day, used) VALUES (?, 0)", (day,))
            used = db.execute("SELECT used FROM family_geocode_usage WHERE day=?", (day,)).fetchone()[0]
            if used >= cap:
                return False
            db.execute("UPDATE family_geocode_usage SET used=used+1 WHERE day=?", (day,))
        return True

    @staticmethod
    def _label(properties: dict[str, Any]) -> str | None:
        parts: list[str] = []
        # Area components only: house numbers, roads and POI names do not belong here.
        for keys in (("suburb", "quarter", "village"), ("district", "city", "town"), ("county", "state")):
            value = next((properties.get(key) for key in keys if properties.get(key)), None)
            if isinstance(value, str) and value.strip() and value.strip().casefold() not in {p.casefold() for p in parts}:
                parts.append(value.strip()[:120])
        return ", ".join(parts) or None

    def forget(self, device_id: str) -> None:
        with self._lock:
            self._latest.pop(device_id, None)

    def resolve(self, device_id: str, location: dict[str, Any] | None) -> dict[str, Any]:
        captured = location.get("captured_at") if location else None
        result: dict[str, Any] = {"label": None, "status": "no_location", "captured_at": captured, "source": "geoapify"}
        if not location:
            self.forget(device_id)
            return result
        key = os.getenv("LILY_FAMILY_GEOAPIFY_API_KEY", "").strip()
        if not key:
            return {**result, "status": "not_configured"}
        now = time.monotonic()
        cell = (round(location["latitude"], 3), round(location["longitude"], 3))
        with self._lock:
            previous = self._latest.get(device_id)
            if previous and previous["cell"] == cell and now - previous["at"] < previous["ttl"]:
                self._latest.move_to_end(device_id)
                return {**result, **previous["result"]}
            if self._busy or now - self._last_request < 1:
                return {**result, "status": "waiting"}
            if previous and now - previous["at"] < 300:
                return {**result, "status": "waiting"}
            self._busy = True
            self._last_request = now
        resolved: dict[str, Any] = {"status": "unavailable", "label": None}
        try:
            if not self._reserve_credit():
                resolved["status"] = "quota_reached"
            else:
                status, payload = self.fetch({
                    "lat": location["latitude"], "lon": location["longitude"],
                    "format": "json", "lang": "id", "limit": 1, "apiKey": key,
                })
                if status == 200:
                    rows = payload.get("results", [])
                    label = self._label(rows[0]) if rows and isinstance(rows[0], dict) else None
                    resolved = {"status": "ready" if label else "unavailable", "label": label}
                elif status == 429:
                    resolved["status"] = "quota_reached"
        except (URLError, OSError, ValueError, TypeError, AttributeError, sqlite3.Error):
            # Provider errors must never include a URL containing coordinates or the API key.
            pass
        finally:
            with self._lock:
                self._busy = False
                self._latest[device_id] = {"cell": cell, "at": now, "ttl": 21600 if resolved["status"] == "ready" else 300, "result": resolved}
                self._latest.move_to_end(device_id)
                while len(self._latest) > 256:
                    self._latest.popitem(last=False)
        return {**result, **resolved}
