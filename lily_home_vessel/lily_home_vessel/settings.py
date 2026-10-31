import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - setup scripts install python-dotenv for runtime.
    def load_dotenv(*_args, **_kwargs):
        return False


BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

DEVICE_ID_RE = re.compile(r"[^a-z0-9_-]+")
MAC_HEX_RE = re.compile(r"[^0-9a-fA-F]+")


@dataclass(frozen=True)
class HomeDeviceConfig:
    id: str
    provider: str
    host: str
    port: int
    kind: str
    name: str
    room: str = ""
    aliases: tuple[str, ...] = ()
    mac: str = ""


def normalize_device_id(value: str) -> str:
    normalized = DEVICE_ID_RE.sub("_", value.strip().lower()).strip("_-")
    return normalized


def normalize_mac_address(value: str) -> str:
    normalized = MAC_HEX_RE.sub("", value).lower()
    return normalized if len(normalized) == 12 else ""


def _parse_bool(raw_value: str, fallback: bool = False) -> bool:
    if raw_value.strip() == "":
        return fallback
    return raw_value.strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _parse_int(raw_value: str, fallback: int) -> int:
    try:
        return int(str(raw_value).strip())
    except (TypeError, ValueError):
        return fallback


def _parse_float(raw_value: str, fallback: float) -> float:
    try:
        return float(str(raw_value).strip())
    except (TypeError, ValueError):
        return fallback


def _parse_host_port(host_value: str, fallback_port: int) -> tuple[str, int]:
    value = host_value.strip()
    if value.count(":") == 1:
        host, raw_port = value.rsplit(":", 1)
        parsed_port = _parse_int(raw_port, fallback_port)
        return host.strip(), parsed_port
    return value, fallback_port


def parse_devices(raw_value: str, default_wiz_port: int = 38899) -> list[HomeDeviceConfig]:
    devices: list[HomeDeviceConfig] = []
    seen: set[str] = set()
    for raw_entry in raw_value.split(";"):
        entry = raw_entry.strip()
        if not entry:
            continue
        if "=" not in entry:
            continue

        raw_id, raw_config = entry.split("=", 1)
        device_id = normalize_device_id(raw_id)
        parts = [part.strip() for part in raw_config.split(",")]
        if not device_id or len(parts) < 2:
            continue

        provider = (parts[0] or "").strip().lower()
        host, port = _parse_host_port(parts[1], default_wiz_port)
        kind = (parts[2] if len(parts) > 2 and parts[2] else "light").strip().lower()
        name = (parts[3] if len(parts) > 3 and parts[3] else device_id.replace("_", " ").title()).strip()
        room = (parts[4] if len(parts) > 4 else "").strip()
        aliases = tuple(alias.strip() for alias in (parts[5] if len(parts) > 5 else "").split("|") if alias.strip())
        mac = normalize_mac_address(parts[6] if len(parts) > 6 else "")

        if provider and host and device_id not in seen:
            devices.append(
                HomeDeviceConfig(
                    id=device_id,
                    provider=provider,
                    host=host,
                    port=port,
                    kind=kind or "device",
                    name=name,
                    room=room,
                    aliases=aliases,
                    mac=mac,
                )
            )
            seen.add(device_id)
    return devices


def parse_scenes(raw_value: str) -> dict[str, list[dict[str, Any]]]:
    raw_value = raw_value.strip()
    if not raw_value:
        return {}
    try:
        payload = json.loads(raw_value)
    except json.JSONDecodeError:
        return {}
    if not isinstance(payload, dict):
        return {}

    scenes: dict[str, list[dict[str, Any]]] = {}
    for raw_name, raw_actions in payload.items():
        scene_id = normalize_device_id(str(raw_name))
        if not scene_id or not isinstance(raw_actions, list):
            continue
        actions = [item for item in raw_actions if isinstance(item, dict) and item.get("device")]
        if actions:
            scenes[scene_id] = actions
    return scenes


class HomeVesselSettings:
    def __init__(self) -> None:
        self.host = os.getenv("LILY_HOME_VESSEL_HOST", "127.0.0.1").strip() or "127.0.0.1"
        self.port = _parse_int(os.getenv("LILY_HOME_VESSEL_PORT", "10896"), 10896)
        self.token = os.getenv("LILY_HOME_VESSEL_TOKEN", "").strip()
        self.cors_allow_origins = os.getenv(
            "LILY_HOME_CORS_ALLOW_ORIGINS",
            os.getenv("LILY_CORS_ALLOW_ORIGINS", "*"),
        ).strip()
        self.wiz_port = _parse_int(os.getenv("LILY_HOME_WIZ_PORT", "38899"), 38899)
        self.wiz_timeout_seconds = max(
            0.1,
            _parse_float(os.getenv("LILY_HOME_WIZ_TIMEOUT_SECONDS", "1.2"), 1.2),
        )
        self.wiz_discovery_broadcast = (
            os.getenv("LILY_HOME_WIZ_DISCOVERY_BROADCAST", "255.255.255.255").strip()
            or "255.255.255.255"
        )
        self.wiz_discovery_timeout_seconds = max(
            0.1,
            _parse_float(os.getenv("LILY_HOME_WIZ_DISCOVERY_TIMEOUT_SECONDS", "2.0"), 2.0),
        )
        self.wiz_recovery_discovery_timeout_seconds = max(
            0.1,
            _parse_float(os.getenv("LILY_HOME_WIZ_RECOVERY_DISCOVERY_TIMEOUT_SECONDS", "0.8"), 0.8),
        )
        self.wiz_auto_discovery_enabled = _parse_bool(
            os.getenv("LILY_HOME_WIZ_AUTO_DISCOVERY_ENABLED", "true"),
            True,
        )
        self.wiz_discovery_cooldown_seconds = max(
            0.0,
            _parse_float(os.getenv("LILY_HOME_WIZ_DISCOVERY_COOLDOWN_SECONDS", "15"), 15.0),
        )
        raw_wiz_cache = os.getenv(
            "LILY_HOME_WIZ_HOST_CACHE_PATH",
            "runtime/wiz-host-cache.json",
        ).strip()
        wiz_cache_path = Path(raw_wiz_cache or "runtime/wiz-host-cache.json").expanduser()
        self.wiz_host_cache_path = wiz_cache_path if wiz_cache_path.is_absolute() else BASE_DIR / wiz_cache_path
        self.offline_failure_threshold = max(
            1,
            _parse_int(os.getenv("LILY_HOME_OFFLINE_FAILURE_THRESHOLD", "4"), 4),
        )
        self.devices = parse_devices(os.getenv("LILY_HOME_DEVICES", ""), self.wiz_port)
        self.scenes = parse_scenes(os.getenv("LILY_HOME_SCENES", ""))
        raw_scene_store = os.getenv("LILY_HOME_SCENE_STORE_PATH", "runtime/scenes.json").strip()
        scene_store_path = Path(raw_scene_store or "runtime/scenes.json").expanduser()
        self.scene_store_path = scene_store_path if scene_store_path.is_absolute() else BASE_DIR / scene_store_path


settings = HomeVesselSettings()
