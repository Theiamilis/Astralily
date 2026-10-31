import json
import os
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any


class WakePowerError(RuntimeError):
    def __init__(self, detail: str, status_code: int = 500) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


class DevicePowerError(RuntimeError):
    def __init__(self, detail: str, status_code: int = 500) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


_PENDING_POWER_LOCK = threading.Lock()
_PENDING_POWER: dict[str, dict[str, Any]] = {}
_POWER_CONFIRM_TTL_SECONDS = 60


def _device_topology_path() -> Path:
    configured = os.getenv("LILY_DEVICE_POWER_TOPOLOGY", "").strip()
    return Path(configured).expanduser() if configured else Path(__file__).resolve().parents[2] / "config" / "topology.json"


def list_device_power_targets() -> list[dict[str, Any]]:
    try:
        payload = json.loads(_device_topology_path().read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DevicePowerError(f"Lily could not read the device registry: {error}", status_code=503) from error

    targets: list[dict[str, Any]] = []
    for device in payload.get("devices", []):
        if not isinstance(device, dict) or not isinstance(device.get("remote_power"), dict):
            continue
        power = device["remote_power"]
        targets.append(
            {
                "id": str(device.get("id") or ""),
                "label": str(device.get("label") or device.get("id") or ""),
                "host": str(device.get("host") or ""),
                "aliases": [str(alias) for alias in device.get("aliases", [])],
                "enabled": power.get("enabled") is True,
                "default": power.get("default") is True,
                "allowed_actions": [str(action) for action in power.get("allowed_actions", [])],
                "wake_enabled": bool((power.get("wake_on_lan") or {}).get("enabled")),
                "wake_mac_env": str((power.get("wake_on_lan") or {}).get("mac_env") or ""),
                "wake_broadcast_env": str((power.get("wake_on_lan") or {}).get("broadcast_env") or ""),
            }
        )
    return targets


def _normalize_power_text(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s-]", " ", (value or "").lower(), flags=re.UNICODE)).strip()


def _target_matches_exact(target: dict[str, Any], requested_target: str) -> bool:
    names = [target.get("id"), target.get("label"), target.get("host"), *target.get("aliases", [])]
    normalized_target = _normalize_power_text(requested_target)
    return any(normalized_target == _normalize_power_text(str(name or "")) for name in names if name)


def _resolve_explicit_power_target(requested_target: str) -> dict[str, Any] | None:
    return next(
        (target for target in list_device_power_targets() if _target_matches_exact(target, requested_target)),
        None,
    )


def resolve_device_power_intent(session_id: str, message: str) -> dict[str, Any] | None:
    now = time.time()
    raw_message = (message or "").strip()
    confirm_match = re.fullmatch(r"/power\s+confirm\s+(\d{4})", raw_message, flags=re.IGNORECASE)
    cancel_pending = bool(re.fullmatch(r"/power\s+cancel", raw_message, flags=re.IGNORECASE))
    with _PENDING_POWER_LOCK:
        pending = _PENDING_POWER.get(session_id)
        if pending and float(pending.get("expires_at") or 0) <= now:
            _PENDING_POWER.pop(session_id, None)
            pending = None

        if cancel_pending and pending:
            _PENDING_POWER.pop(session_id, None)
            return {"kind": "denied", **pending}
        if confirm_match and not pending:
            return {"kind": "no_pending"}
        if confirm_match and confirm_match.group(1) != str(pending.get("confirmation_code") or ""):
            return {"kind": "invalid_confirmation", **pending}
        if confirm_match and pending:
            _PENDING_POWER.pop(session_id, None)
            return {"kind": "confirmed", **pending}

    if cancel_pending:
        return {"kind": "no_pending"}
    if not raw_message.lower().startswith("/power"):
        return None

    status_match = re.fullmatch(r"/power\s+status\s+(.+?)", raw_message, flags=re.IGNORECASE)
    if status_match:
        requested_target = status_match.group(1).strip()
        target = _resolve_explicit_power_target(requested_target)
        if not target:
            return {"kind": "unknown_target", "action": "status", "requested_target": requested_target}
        return {"kind": "status", "target": target, "action": "status"}

    history_match = re.fullmatch(r"/power\s+history(?:\s+(.+?))?", raw_message, flags=re.IGNORECASE)
    if history_match:
        requested_target = str(history_match.group(1) or "").strip()
        if not requested_target:
            return {"kind": "history", "action": "history"}
        target = _resolve_explicit_power_target(requested_target)
        if not target:
            return {"kind": "unknown_target", "action": "history", "requested_target": requested_target}
        return {"kind": "history", "target": target, "action": "history"}

    command_match = re.fullmatch(
        r"/power\s+(shutdown|restart|hibernate|abort)\s+(.+?)",
        raw_message,
        flags=re.IGNORECASE,
    )
    if not command_match:
        return {"kind": "help"}

    requested_action = command_match.group(1).lower()
    action = "cancel" if requested_action == "abort" else requested_action
    requested_target = command_match.group(2).strip()
    target = _resolve_explicit_power_target(requested_target)
    if not target:
        return {"kind": "unknown_target", "action": action, "requested_target": requested_target}
    if not target.get("enabled"):
        return {"kind": "unavailable", "target": target, "action": action}
    if action not in set(target.get("allowed_actions") or []):
        return {"kind": "unavailable", "target": target, "action": action}

    pending = {
        "id": f"power_{uuid.uuid4().hex[:8]}",
        "target": target,
        "action": action,
        "confirmation_code": f"{secrets.randbelow(10_000):04d}",
        "created_at": now,
        "expires_at": now + _POWER_CONFIRM_TTL_SECONDS,
    }
    with _PENDING_POWER_LOCK:
        _PENDING_POWER[session_id] = pending
    return {"kind": "pending", **pending}


def clear_pending_device_power(session_id: str = "") -> None:
    with _PENDING_POWER_LOCK:
        if session_id:
            _PENDING_POWER.pop(session_id, None)
        else:
            _PENDING_POWER.clear()


def _device_power_executor_url() -> str:
    explicit = os.getenv("LILY_DEVICE_POWER_EXECUTOR_URL", "").strip()
    if explicit:
        return explicit
    tool_url = os.getenv("LILY_TOOL_AGENT_URL", "http://127.0.0.1:8092/api/tool/run").strip()
    if tool_url.endswith("/api/tool/run"):
        return tool_url[: -len("/api/tool/run")] + "/api/device-power/run"
    return tool_url.rstrip("/") + "/api/device-power/run"


def _device_power_executor_base_url() -> str:
    run_url = _device_power_executor_url()
    return run_url[: -len("/api/device-power/run")] if run_url.endswith("/api/device-power/run") else run_url.rstrip("/")


def _device_power_executor_request(path: str, query: dict[str, str | int] | None = None) -> dict[str, Any]:
    token = os.getenv("LILY_DEVICE_POWER_EXECUTOR_TOKEN", "").strip() or os.getenv("LILY_TOOL_AGENT_TOKEN", "").strip()
    url = f"{_device_power_executor_base_url()}{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    headers = {"Accept": "application/json"}
    if token:
        headers["X-Lily-Token"] = token
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            payload = response.read().decode("utf-8")
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="ignore")
        try:
            detail = str(json.loads(detail).get("detail") or detail)
        except ValueError:
            pass
        raise DevicePowerError(detail or f"Power executor returned HTTP {error.code}.", error.code) from error
    except Exception as error:
        raise DevicePowerError(f"Power executor could not be reached: {error}", 503) from error


def get_device_power_status(target: str = "") -> dict[str, Any]:
    query: dict[str, str | int] = {}
    if target.strip():
        query["target"] = target.strip()
    return _device_power_executor_request("/api/device-power/status", query)


def get_device_power_history(target: str = "", limit: int = 30) -> dict[str, Any]:
    query: dict[str, str | int] = {"limit": max(1, min(limit, 200))}
    if target.strip():
        query["target"] = target.strip()
    return _device_power_executor_request("/api/device-power/history", query)


def execute_device_power(target: str, action: str, source: str, reason: str) -> dict[str, Any]:
    token = os.getenv("LILY_DEVICE_POWER_EXECUTOR_TOKEN", "").strip() or os.getenv("LILY_TOOL_AGENT_TOKEN", "").strip()
    body = json.dumps(
        {
            "target": target,
            "action": action,
            "confirmed": True,
            "source": source[:80],
            "reason": reason[:240],
        }
    ).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Lily-Token"] = token
    request = urllib.request.Request(_device_power_executor_url(), data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = response.read().decode("utf-8")
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="ignore")
        try:
            parsed = json.loads(detail)
            detail = str(parsed.get("detail") or detail)
        except ValueError:
            pass
        raise DevicePowerError(detail or f"Power executor returned HTTP {error.code}.", error.code) from error
    except Exception as error:
        raise DevicePowerError(f"Power executor could not be reached: {error}", 503) from error


def is_wake_power_message(message: str) -> bool:
    from .device_intent import safe_wake_fallback

    return safe_wake_fallback(message)


def _normalize_mac_address(mac: str) -> str:
    cleaned = re.sub(r"[^0-9A-Fa-f]", "", (mac or "").strip())
    if len(cleaned) != 12:
        raise ValueError("Invalid MAC address format.")
    return cleaned.upper()


def _send_wake_on_lan(mac: str, broadcast_ip: str, port: int) -> None:
    normalized = _normalize_mac_address(mac)
    payload = bytes.fromhex("FF" * 6 + normalized * 16)

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.sendto(payload, (broadcast_ip, port))


def _call_wake_executor(executor_url: str, executor_token: str | None, source: str, reason: str) -> dict[str, Any]:
    body = json.dumps(
        {
            "source": source,
            "reason": reason,
        }
    ).encode("utf-8")
    headers = {"Content-Type": "application/json"}

    if executor_token:
        headers["X-Lily-Token"] = executor_token

    request = urllib.request.Request(
        executor_url,
        data=body,
        headers=headers,
        method="POST",
    )

    with urllib.request.urlopen(request, timeout=10) as response:
        payload = response.read().decode("utf-8")
        return json.loads(payload) if payload else {}


def execute_wake_power(source: str, reason: str, force_local: bool = False) -> dict[str, Any]:
    executor_url = os.getenv("LILY_WAKE_EXECUTOR_URL", "").strip()
    executor_token = os.getenv("LILY_WAKE_EXECUTOR_TOKEN", "").strip() or None
    local_mac = os.getenv("LILY_CORE_MAC", "").strip()
    broadcast_ip = os.getenv("LILY_WAKE_BROADCAST_IP", "255.255.255.255").strip()
    port = int(os.getenv("LILY_WAKE_PORT", "9"))

    executor_error = ""
    if executor_url and not force_local:
        try:
            executor_result = _call_wake_executor(
                executor_url=executor_url,
                executor_token=executor_token,
                source=source,
                reason=reason,
            )
            return {
                "status": "ok",
                "mode": "executor",
                "executor_url": executor_url,
                "result": executor_result,
                "timestamp": datetime.utcnow(),
            }
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="ignore")
            executor_error = f"Wake executor HTTP error: {error.code} {detail}".strip()
        except Exception as error:
            executor_error = f"Wake executor request failed: {error}"

    if not local_mac:
        detail = "No wake executor is available and local MAC is not configured."
        if executor_error:
            detail = f"{executor_error}; {detail}"
        raise WakePowerError(detail, status_code=503)

    try:
        _send_wake_on_lan(local_mac, broadcast_ip, port)
    except ValueError as error:
        raise WakePowerError(str(error), status_code=500) from error
    except OSError as error:
        raise WakePowerError(f"Failed to send Wake-on-LAN packet: {error}", status_code=500) from error

    return {
        "status": "ok",
        "mode": "local",
        "broadcast_ip": broadcast_ip,
        "port": port,
        "timestamp": datetime.utcnow(),
    }


def execute_target_wake_power(target_id: str, source: str, reason: str) -> dict[str, Any]:
    """Send WoL for one registered target without exposing its MAC to callers."""
    target = next(
        (item for item in list_device_power_targets() if item.get("id") == target_id),
        None,
    )
    if not target or not target.get("enabled"):
        raise WakePowerError("Target wake control is not enabled.", status_code=409)
    if not target.get("wake_enabled"):
        raise WakePowerError(f"Wake-on-LAN is not enabled for {target.get('label') or target_id}.", status_code=409)

    mac_env = str(target.get("wake_mac_env") or "").strip()
    mac = os.getenv(mac_env, "").strip() if mac_env else ""
    if not mac:
        raise WakePowerError(
            f"Wake-on-LAN MAC for {target.get('label') or target_id} is not configured ({mac_env or 'missing env key'}).",
            status_code=503,
        )
    broadcast_env = str(target.get("wake_broadcast_env") or "").strip() or "LILY_WAKE_BROADCAST_IP"
    broadcast_ip = os.getenv(broadcast_env, "255.255.255.255").strip() or "255.255.255.255"
    port = int(os.getenv("LILY_WAKE_PORT", "9"))
    try:
        _send_wake_on_lan(mac, broadcast_ip, port)
    except ValueError as error:
        raise WakePowerError(str(error), status_code=500) from error
    except OSError as error:
        raise WakePowerError(f"Failed to send Wake-on-LAN packet: {error}", status_code=500) from error
    return {
        "status": "ok",
        "mode": "target_local",
        "target": target["id"],
        "broadcast_ip": broadcast_ip,
        "port": port,
        "source": source,
        "reason": reason,
        "timestamp": datetime.utcnow(),
    }


def verify_optional_wake_token(expected_token: str | None, provided_token: str | None) -> None:
    if expected_token and provided_token != expected_token:
        raise WakePowerError("Wake token is invalid.", status_code=403)
