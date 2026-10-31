"""Owner-only projection of the Core host's Tailscale device inventory."""
from __future__ import annotations

import hmac
import ipaddress
import json
import re
import subprocess
import threading
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from .settings import settings


def _require_owner(request: Request, x_lily_owner_token: str = Header(default="")) -> None:
    authorization = request.headers.get("authorization", "").strip()
    provided = authorization[7:].strip() if authorization.lower().startswith("bearer ") else x_lily_owner_token
    if not settings.owner_api_token:
        raise HTTPException(503, "Owner API authentication is not configured.")
    if not hmac.compare_digest(provided.encode("utf-8"), settings.owner_api_token.encode("utf-8")):
        raise HTTPException(401, "Owner authentication required.")


router = APIRouter(tags=["network-devices"], dependencies=[Depends(_require_owner)])
_lock = threading.Lock()
_cached: dict[str, Any] | None = None
_cached_until = 0.0
_labels = {
    "lily-core-host": "lily-core-host", "Lily User-s349": "lily-core-host", "lily-core-host": "lily-core-host",
    "Lily-Storage-Host": "Lily-Storage-Host PC", "Lily-Storage-Host": "Lily-Storage-Host PC",
    "Lily-Voice-Host": "Lily-Voice-Host", "Lily-User-Laptop": "Lily-User-Laptop",
    "owner-mobile-host": "owner mobile 5G",
}


def project_devices(payload: dict[str, Any]) -> list[dict[str, Any]]:
    peers = payload.get("Peer", {})
    nodes = [payload.get("Self", {}), *(peers.values() if isinstance(peers, dict) else [])]
    devices: dict[str, dict[str, Any]] = {}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        host = str(node.get("HostName") or "").strip()[:128]
        dns = str(node.get("DNSName") or "").rstrip(".")[:253]
        short_dns = dns.split(".", 1)[0].casefold()
        if any(re.fullmatch(r"muse(?:-\d+)?", value) for value in (host.casefold(), short_dns)):
            continue
        address = ""
        for value in node.get("TailscaleIPs") or []:
            try:
                ip = ipaddress.ip_address(value)
            except (ValueError, TypeError):
                continue
            if ip.version == 4:
                address = str(ip)
                break
        identity = str(node.get("ID") or dns or address)
        if not identity or not (host or dns):
            continue
        devices[identity] = {
            "id": identity,
            "name": _labels.get(short_dns) or _labels.get(host.casefold()) or host or short_dns,
            "os": str(node.get("OS") or "unknown")[:32],
            "address": address or None,
            "online": node.get("Online") is True,
            "is_core_host": node is nodes[0],
        }
    return sorted(devices.values(), key=lambda item: (not item["is_core_host"], item["name"].casefold()))


@router.get("/api/owner/network/devices")
def get_network_devices() -> dict[str, Any]:
    global _cached, _cached_until
    with _lock:
        if _cached is not None and time.monotonic() < _cached_until:
            return _cached
        try:
            result = subprocess.run(
                ["tailscale", "status", "--json"], capture_output=True,
                text=True, timeout=4, check=True,
            )
            if len(result.stdout) > 2 * 1024 * 1024:
                raise ValueError("Device inventory exceeded its limit.")
            payload = json.loads(result.stdout)
            if not isinstance(payload, dict) or payload.get("BackendState") != "Running":
                raise ValueError("Tailscale is not connected.")
            devices = project_devices(payload)
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            raise HTTPException(503, "Tailscale device inventory is unavailable on the Core host.") from None
        _cached = {
            "devices": devices, "source": "tailscale",
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
        _cached_until = time.monotonic() + 30
        return _cached
