import json
import re
import socket
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .schemas import DeviceControlRequest
from .settings import HomeDeviceConfig, normalize_mac_address


class HomeVesselError(RuntimeError):
    def __init__(self, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def _request_id() -> int:
    return int(time.time() * 1000) % 100000


def _parse_response(data: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HomeVesselError("WiZ device returned an invalid response.", 502) from error
    if not isinstance(payload, dict):
        raise HomeVesselError("WiZ device returned an unsupported response.", 502)
    if payload.get("error"):
        raise HomeVesselError(f"WiZ device returned an error: {payload['error']}", 502)
    return payload


def validate_rgb(rgb: list[int] | None) -> tuple[int, int, int] | None:
    if rgb is None:
        return None
    if len(rgb) != 3:
        raise HomeVesselError("RGB must contain exactly three values.", 422)
    values = tuple(int(item) for item in rgb)
    if any(item < 0 or item > 255 for item in values):
        raise HomeVesselError("RGB values must be between 0 and 255.", 422)
    return values


def build_wiz_pilot_params(request: DeviceControlRequest) -> dict[str, Any]:
    params: dict[str, Any] = {}
    if request.state == "on":
        params["state"] = True
    if request.brightness is not None:
        params["dimming"] = request.brightness
    if request.temperature_kelvin is not None:
        params["temp"] = request.temperature_kelvin
    if request.rgb is not None:
        r, g, b = validate_rgb(request.rgb)
        params.update({"r": r, "g": g, "b": b})
    if request.scene_id is not None:
        params["sceneId"] = request.scene_id
    if request.speed is not None:
        params["speed"] = request.speed
    return params


class WizClient:
    def __init__(self, host: str, port: int = 38899, timeout_seconds: float = 1.2) -> None:
        self.host = host
        self.port = port
        self.timeout_seconds = timeout_seconds

    def send(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = {
            "id": _request_id(),
            "method": method,
            "params": params or {},
        }
        message = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(self.timeout_seconds)
            try:
                sock.sendto(message, (self.host, self.port))
                data, _addr = sock.recvfrom(8192)
            except socket.timeout as error:
                raise HomeVesselError(f"WiZ device did not respond at {self.host}:{self.port}.", 504) from error
            except OSError as error:
                raise HomeVesselError(f"Could not reach WiZ device at {self.host}:{self.port}: {error}", 502) from error
        return _parse_response(data)

    def get_pilot(self) -> dict[str, Any]:
        return self.send("getPilot", {})

    def set_state(self, request: DeviceControlRequest) -> dict[str, Any]:
        if request.state == "toggle":
            current = normalize_wiz_state("", "wiz", self.get_pilot())
            request = request.model_copy(update={"state": "off" if current.get("state") else "on"})

        if request.state == "off" and not any(
            value is not None
            for value in (request.brightness, request.temperature_kelvin, request.rgb, request.scene_id, request.speed)
        ):
            return self.send("setState", {"state": False})

        params = build_wiz_pilot_params(request)
        if request.state == "off":
            params["state"] = False
        if not params:
            raise HomeVesselError("No WiZ control fields were provided.", 422)
        return self.send("setPilot", params)


def normalize_wiz_state(device_id: str, provider: str, payload: dict[str, Any]) -> dict[str, Any]:
    result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
    rgb = None
    if all(key in result for key in ("r", "g", "b")):
        rgb = [int(result["r"]), int(result["g"]), int(result["b"])]
    return {
        "device_id": device_id,
        "provider": provider,
        "online": True,
        "state": result.get("state") if isinstance(result.get("state"), bool) else None,
        "brightness": result.get("dimming") if isinstance(result.get("dimming"), int) else None,
        "temperature_kelvin": result.get("temp") if isinstance(result.get("temp"), int) else None,
        "rgb": rgb,
        "scene_id": result.get("sceneId") if isinstance(result.get("sceneId"), int) else None,
        "raw": result,
    }


def discover_wiz_devices(
    broadcast_space: str,
    timeout_seconds: float,
    port: int = 38899,
    max_devices: int = 64,
    expected_macs: set[str] | None = None,
) -> list[dict[str, Any]]:
    request = json.dumps({"id": _request_id(), "method": "getPilot", "params": {}}).encode("utf-8")
    deadline = time.monotonic() + timeout_seconds
    devices: dict[str, dict[str, Any]] = {}

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.settimeout(min(timeout_seconds, 0.5))
        try:
            sock.sendto(request, (broadcast_space, port))
        except OSError as error:
            raise HomeVesselError(f"Could not broadcast WiZ discovery: {error}", 502) from error

        while time.monotonic() < deadline and len(devices) < max_devices:
            try:
                data, addr = sock.recvfrom(8192)
            except socket.timeout:
                continue
            payload = _parse_response(data)
            result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
            host = addr[0]
            devices[host] = {
                "host": host,
                "port": port,
                "mac": str(result.get("mac") or ""),
                "state": result.get("state") if isinstance(result.get("state"), bool) else None,
                "raw": result,
            }
            if expected_macs:
                discovered_macs = {
                    normalize_mac_address(str(device.get("mac") or ""))
                    for device in devices.values()
                }
                if expected_macs.issubset(discovered_macs):
                    break

    return list(devices.values())


class WizHostResolver:
    def __init__(
        self,
        devices: list[HomeDeviceConfig],
        cache_path: Path,
        broadcast_space: str,
        port: int,
        discovery_timeout_seconds: float,
        recovery_timeout_seconds: float,
        cooldown_seconds: float,
        enabled: bool = True,
        discover: Callable[..., list[dict[str, Any]]] = discover_wiz_devices,
    ) -> None:
        self.devices = [device for device in devices if device.provider == "wiz"]
        self.cache_path = cache_path
        self.broadcast_space = broadcast_space
        self.port = port
        self.discovery_timeout_seconds = discovery_timeout_seconds
        self.recovery_timeout_seconds = recovery_timeout_seconds
        self.cooldown_seconds = cooldown_seconds
        self.enabled = enabled
        self._discover = discover
        self._lock = threading.Lock()
        self._last_discovery = 0.0
        self._cache = self._load_cache()
        self._hosts: dict[str, str] = {}
        for device in self.devices:
            cached_entry = self._cache.get(device.id, {})
            cached_mac = normalize_mac_address(cached_entry.get("mac", ""))
            cache_matches = not device.mac or cached_mac == device.mac
            self._hosts[device.id] = str(cached_entry.get("host") or device.host) if cache_matches else device.host

    def _load_cache(self) -> dict[str, dict[str, str]]:
        try:
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {}
        raw_devices = payload.get("devices") if isinstance(payload, dict) else None
        if not isinstance(raw_devices, dict):
            return {}
        cache: dict[str, dict[str, str]] = {}
        for device_id, raw_entry in raw_devices.items():
            if not isinstance(raw_entry, dict):
                continue
            host = str(raw_entry.get("host") or "").strip()
            mac = normalize_mac_address(str(raw_entry.get("mac") or ""))
            if host:
                cache[str(device_id)] = {"host": host, "mac": mac}
        return cache

    def _write_cache(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "devices": {
                device_id: {
                    "host": entry["host"],
                    "mac": entry.get("mac", ""),
                }
                for device_id, entry in sorted(self._cache.items())
            },
        }
        temporary_path = self.cache_path.with_name(f".{self.cache_path.name}.tmp")
        temporary_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        temporary_path.replace(self.cache_path)

    def _device_mac(self, device: HomeDeviceConfig) -> str:
        return device.mac or normalize_mac_address(self._cache.get(device.id, {}).get("mac", ""))

    @staticmethod
    def _alias_mac_suffix(device: HomeDeviceConfig) -> str:
        for alias in device.aliases:
            normalized = alias.strip().lower().replace("-", "_")
            if not normalized.startswith("wiz_"):
                continue
            suffix = re.sub(r"[^0-9a-f]", "", normalized[4:])
            if 4 <= len(suffix) <= 12:
                return suffix
        return ""

    def resolve_host(self, device: HomeDeviceConfig) -> str:
        return self._hosts.get(device.id, device.host)

    def refresh(self, *, force: bool = False, recovery: bool = False) -> bool:
        if not self.enabled or not self.devices:
            return False
        with self._lock:
            now = time.monotonic()
            minimum_interval = 1.0 if force else self.cooldown_seconds
            if self._last_discovery and now - self._last_discovery < minimum_interval:
                return False
            self._last_discovery = now
            expected_macs = {mac for device in self.devices if (mac := self._device_mac(device))}
            discovered = self._discover(
                broadcast_space=self.broadcast_space,
                timeout_seconds=(
                    self.recovery_timeout_seconds if recovery else self.discovery_timeout_seconds
                ),
                port=self.port,
                expected_macs=expected_macs or None,
            )
            changed = False
            for device in self.devices:
                target_mac = self._device_mac(device)
                alias_suffix = self._alias_mac_suffix(device)
                match = None
                for candidate in discovered:
                    candidate_mac = normalize_mac_address(str(candidate.get("mac") or ""))
                    if target_mac and candidate_mac == target_mac:
                        match = candidate
                        break
                    if not target_mac and alias_suffix and candidate_mac.endswith(alias_suffix):
                        match = candidate
                        break
                    if not target_mac and str(candidate.get("host") or "") == device.host:
                        match = candidate
                        break
                if not match:
                    continue
                host = str(match.get("host") or "").strip()
                mac = normalize_mac_address(str(match.get("mac") or ""))
                if not host:
                    continue
                if self._hosts.get(device.id) != host:
                    changed = True
                if self._cache.get(device.id) != {"host": host, "mac": mac}:
                    changed = True
                self._hosts[device.id] = host
                self._cache[device.id] = {"host": host, "mac": mac}
            if changed:
                self._write_cache()
            return changed

    def refresh_device(self, device: HomeDeviceConfig) -> str:
        self.refresh(force=True, recovery=True)
        return self.resolve_host(device)
