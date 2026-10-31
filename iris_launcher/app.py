from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

if __package__:
    from .google_contacts import GoogleContacts
    from .vessel_setup import VesselSetup
    from .device_updates import snapshot as device_updates_snapshot
else:
    from google_contacts import GoogleContacts
    from vessel_setup import VesselSetup
    from device_updates import snapshot as device_updates_snapshot


ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = Path(__file__).resolve().parent / "static"
RUNTIME_DIR = Path(__file__).resolve().parent / "runtime"
SETTINGS_PATH = RUNTIME_DIR / "settings.json"
SESSION_PATH = RUNTIME_DIR / "session.json"
POWERSHELL_LAUNCHER = ROOT / "scripts" / "lily.ps1"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5240
MAX_BODY_BYTES = 64 * 1024
PROXY_MAX_BODY_BYTES = 18 * 1024 * 1024
CONFIG_LOCK = threading.RLock()
GOOGLE_CONTACTS = GoogleContacts(RUNTIME_DIR)
VESSEL_SETUP = VesselSetup(RUNTIME_DIR)
BROWSER_CLIENT_ORIGINS = {
    f"http://{host}:{port}"
    for host in ("127.0.0.1", "localhost")
    for port in (5230, 5231, 5232)
}

# Only this checkout is editable. Remote copies are never reached over SSH.
LOCAL_CLIENTS = {
    "private": ("lily_private_realm", "VITE_LILY_API_URL", "Restart Vite; rebuild packaged frontend."),
    "control": ("lily_control_center", "VITE_LILY_API_URL", "Restart Vite; rebuild packaged frontend."),
    "stage": ("lily_stream_stage", "VITE_LILY_API_URL", "Restart Vite; rebuild packaged frontend."),
    "wa": ("lily_wa_vessel", "LILY_CORE_URL", "Restart this local WA process; remote WA is unchanged."),
    "hotkey": ("lily_hotkey_vessel", "LILY_CORE_URL", "Restart the local hotkey process."),
    "hud": ("lily_hud_vessel", "VITE_LILY_CORE_WS_URL", "Rebuild and reopen HUD; the installed EXE keeps its built-in URL."),
}


@dataclass(frozen=True)
class ServiceDefinition:
    id: str
    label: str
    port: int
    health_path: str
    command: str
    description: str


SERVICE_DEFINITIONS = {
    "core": ServiceDefinition(
        id="core",
        label="Essence Core",
        port=8000,
        health_path="/health/live",
        command="core",
        description="Conversation routing, memory, tools, and orchestration.",
    ),
    "voice": ServiceDefinition(
        id="voice",
        label="Voice Stack",
        port=10881,
        health_path="/health/live",
        command="voice",
        description="GPT-SoVITS engine and the local Voice Vessel.",
    ),
    "private": ServiceDefinition(
        id="private",
        label="Private Realm",
        port=5230,
        health_path="/",
        command="private",
        description="The private Live2D companion room.",
    ),
}

PUBLIC_CONFIG_KEYS = {
    "core_url": ("lily_private_realm", "VITE_LILY_API_URL", "http://127.0.0.1:8000"),
    "brain_provider": ("lily_essence_core", "LILY_BRAIN_PROVIDER", "lmstudio"),
    "provider_base": ("lily_essence_core", "LILY_OPENAI_COMPAT_BASE", "http://127.0.0.1:1430/v1"),
    "brain_model": ("lily_essence_core", "LILY_OPENAI_COMPAT_BRAIN_MODEL", "gpt-5.4"),
    "voice_provider": ("lily_essence_core", "LILY_VOICE_PROVIDER", "sovits"),
    "voice_profile": ("lily_essence_core", "LILY_VOICE_PROFILE_JA", "ja"),
    "live2d_model_url": (
        "lily_private_realm",
        "VITE_LIVE2D_MODEL_URL",
        "/live2d/jiraikei_dlc/jiraikei.model3.json",
    ),
    "realm_variant": ("lily_private_realm", "VITE_REALM_VARIANT", "classic"),
}

ENV_LINE_RE = re.compile(r"^(?P<prefix>\s*(?:export\s+)?)(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*=.*$")
SAFE_VALUE_RE = re.compile(r"^[^\r\n\x00]{0,4096}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except FileNotFoundError:
        return values
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def ensure_env_file(component: str) -> Path:
    folder = ROOT / component
    destination = folder / ".env"
    if destination.exists():
        return destination
    example = folder / ".env.example"
    if not example.exists():
        raise FileNotFoundError(f"Missing {component}/.env.example")
    shutil.copyfile(example, destination)
    return destination


def update_env_file(path: Path, updates: dict[str, str]) -> None:
    for key, value in updates.items():
        if not ENV_LINE_RE.match(f"{key}=") or not SAFE_VALUE_RE.match(value):
            raise ValueError(f"Unsafe environment value for {key}")

    try:
        original = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        original = ""
    newline = "\r\n" if "\r\n" in original else "\n"
    lines = original.splitlines()
    seen: set[str] = set()
    output: list[str] = []

    for line in lines:
        match = ENV_LINE_RE.match(line)
        key = match.group("key") if match else ""
        if key in updates:
            output.append(f"{match.group('prefix')}{key}={updates[key]}")
            seen.add(key)
        else:
            output.append(line)

    missing = [key for key in updates if key not in seen]
    if missing and output and output[-1].strip():
        output.append("")
    if missing:
        output.append("# Managed by IRIS Launcher")
        output.extend(f"{key}={updates[key]}" for key in missing)

    rendered = newline.join(output)
    if rendered:
        rendered += newline
    temporary = path.with_suffix(path.suffix + ".iris.tmp")
    temporary.write_text(rendered, encoding="utf-8", newline="")
    os.replace(temporary, path)


def normalize_http_url(value: Any, field: str) -> str:
    raw = str(value or "").strip().rstrip("/")
    if not raw or len(raw) > 512:
        raise ValueError(f"{field} is required")
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"{field} must be an http(s) URL")
    return raw


def normalize_text(value: Any, field: str, *, max_length: int = 160) -> str:
    raw = str(value or "").strip()
    if not raw or len(raw) > max_length or not SAFE_VALUE_RE.match(raw):
        raise ValueError(f"Invalid {field}")
    return raw


def local_host(url: str) -> bool:
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host in {"127.0.0.1", "localhost", "0.0.0.0", "::1", "::"}


def list_value(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def set_list_member(value: str, member: str, enabled: bool) -> str:
    items = list_value(value)
    lowered = {item.lower() for item in items}
    if enabled and member.lower() not in lowered:
        items.append(member)
    if not enabled:
        items = [item for item in items if item.lower() != member.lower()]
    return ",".join(items)


def read_config() -> dict[str, Any]:
    env_cache: dict[str, dict[str, str]] = {}

    def values(component: str) -> dict[str, str]:
        if component not in env_cache:
            folder = ROOT / component
            source = folder / ".env" if (folder / ".env").exists() else folder / ".env.example"
            env_cache[component] = parse_env_file(source)
        return env_cache[component]

    config: dict[str, Any] = {}
    for public_key, (component, env_key, fallback) in PUBLIC_CONFIG_KEYS.items():
        config[public_key] = values(component).get(env_key, fallback) or fallback

    core = values("lily_essence_core")
    voice_url = core.get("LILY_VOICE_SERVICE_URL", "").strip()
    disabled = {item.lower() for item in list_value(core.get("LILY_DISABLED_COMPONENTS", ""))}
    if "voice" in disabled:
        voice_mode = "off"
    elif voice_url and not local_host(voice_url):
        voice_mode = "remote"
    else:
        voice_mode = "local"

    core_token = core.get("LILY_OWNER_API_TOKEN", "")
    config.update(
        {
            "voice_mode": voice_mode,
            "voice_service_url": voice_url or "http://127.0.0.1:10881/api/voice/synthesize",
            "owner_token_configured": bool(core_token),
            "owner_token_aligned": bool(core_token),
            "provider_api_key_configured": bool(core.get("LILY_OPENAI_COMPAT_API_KEY", "")),
            "setup_complete": bool(read_json(SETTINGS_PATH, {}).get("setup_complete")),
        }
    )
    return config


def save_setup(payload: dict[str, Any]) -> dict[str, Any]:
    with CONFIG_LOCK:
        return _save_setup(payload)


def _save_setup(payload: dict[str, Any]) -> dict[str, Any]:
    core_url = normalize_http_url(payload.get("core_url"), "Core URL")
    provider = normalize_text(payload.get("brain_provider"), "brain provider", max_length=32).lower()
    if provider not in {"lmstudio", "openai_compat"}:
        raise ValueError("Brain provider must be lmstudio or openai_compat")
    provider_base = normalize_http_url(payload.get("provider_base"), "provider base URL")
    brain_model = normalize_text(payload.get("brain_model"), "brain model")
    voice_mode = normalize_text(payload.get("voice_mode"), "voice mode", max_length=16).lower()
    if voice_mode not in {"local", "remote", "off"}:
        raise ValueError("Voice mode must be local, remote, or off")
    voice_service_url = normalize_http_url(payload.get("voice_service_url"), "Voice Vessel URL")
    voice_provider = normalize_text(payload.get("voice_provider"), "voice provider", max_length=32).lower()
    if voice_provider not in {"sovits", "sovits2", "rvc", "alibaba"}:
        raise ValueError("Unsupported voice provider")
    voice_profile = normalize_text(payload.get("voice_profile"), "voice profile", max_length=64)
    model_url = normalize_text(payload.get("live2d_model_url"), "Live2D model URL", max_length=512)
    if not (model_url.startswith("/") or model_url.startswith("http://") or model_url.startswith("https://")):
        raise ValueError("Live2D model URL must be a local /path or http(s) URL")
    variant = normalize_text(payload.get("realm_variant"), "realm variant", max_length=32)
    if variant not in {"classic", "sweet-room", "pet"}:
        raise ValueError("Unsupported realm variant")

    core_path = ensure_env_file("lily_essence_core")
    realm_path = ensure_env_file("lily_private_realm")
    voice_path = ensure_env_file("lily_voice_vessel")
    core_values = parse_env_file(core_path)
    disabled = core_values.get("LILY_DISABLED_COMPONENTS", "")
    disabled = set_list_member(disabled, "voice", voice_mode == "off")

    core_updates = {
        "LILY_BRAIN_PROVIDER": provider,
        "LILY_TEXT_PROVIDER_CHAIN": "lmstudio,openai_compat" if provider == "lmstudio" else "openai_compat,lmstudio",
        "LILY_OPENAI_COMPAT_BASE": provider_base,
        "LILY_OPENAI_COMPAT_BRAIN_MODEL": brain_model,
        "LILY_DISABLED_COMPONENTS": disabled,
        "LILY_VOICE_PROVIDER": voice_provider,
        "LILY_VOICE_PROFILE_JA": voice_profile,
    }

    if voice_mode == "local":
        core_updates.update(
            {
                "GPTSOVITS_API_URL": "http://127.0.0.1:10880",
                "LILY_VOICE_SERVICE_URL": "http://127.0.0.1:10881/api/voice/synthesize",
                "LILY_VOICE_SERVICE_HEALTH_URL": "http://127.0.0.1:10881/health",
            }
        )
    elif voice_mode == "remote":
        voice_base = voice_service_url.split("/api/", 1)[0].rstrip("/")
        core_updates.update(
            {
                "LILY_VOICE_SERVICE_URL": voice_service_url,
                "LILY_VOICE_SERVICE_HEALTH_URL": f"{voice_base}/health",
            }
        )
    else:
        core_updates.update({"LILY_VOICE_SERVICE_URL": "", "LILY_VOICE_SERVICE_HEALTH_URL": ""})

    realm_updates = {
        "VITE_LILY_API_URL": core_url,
        "VITE_LIVE2D_MODEL_URL": model_url,
        "VITE_REALM_VARIANT": variant,
    }
    voice_updates = {
        "LILY_VOICE_DEFAULT_PROFILE": voice_profile,
        "GPTSOVITS_API_URL": "http://127.0.0.1:10880",
    }

    owner_token = str(payload.get("owner_token") or "").strip()
    if owner_token:
        if len(owner_token) > 512 or not SAFE_VALUE_RE.match(owner_token):
            raise ValueError("Invalid owner token")
        core_updates["LILY_OWNER_API_TOKEN"] = owner_token
        core_updates["LILY_OWNER_API_TOKEN_ENFORCED"] = "true"
        realm_updates["VITE_LILY_OWNER_API_TOKEN"] = ""

    provider_key = str(payload.get("provider_api_key") or "").strip()
    if provider_key:
        if len(provider_key) > 2048 or not SAFE_VALUE_RE.match(provider_key):
            raise ValueError("Invalid provider API key")
        core_updates["LILY_OPENAI_COMPAT_API_KEY"] = provider_key

    update_env_file(core_path, core_updates)
    update_env_file(realm_path, realm_updates)
    update_env_file(voice_path, voice_updates)
    if owner_token:
        write_json_atomic(RUNTIME_DIR / "core-access.json", {"core_url": core_url.rstrip("/"), "owner_token": owner_token})
    write_json_atomic(
        SETTINGS_PATH,
        {
            "setup_complete": True,
            "voice_mode": voice_mode,
            "updated_at": utc_now(),
        },
    )
    return read_config()


def client_core_url(value: Any, *, websocket: bool = False) -> str:
    """Strict origin validation: no credentials or dotenv/shell metacharacters."""
    if not isinstance(value, str) or len(value) > 512:
        raise ValueError("Enter a valid Core origin URL.")
    raw = value.strip().rstrip("/")
    if any(c.isspace() or ord(c) < 32 or c in "\\\"'$`#" for c in raw):
        raise ValueError("Core URL contains unsafe characters.")
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port
    except ValueError as error:
        raise ValueError("Core URL has an invalid host or port.") from error
    schemes = {"ws", "wss"} if websocket else {"http", "https"}
    expected_path = "/ws/hud" if websocket else ""
    if (parsed.scheme not in schemes or not parsed.hostname
            or parsed.hostname in {"0.0.0.0", "::"} or port == 0
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or parsed.path != expected_path):
        raise ValueError("Use a Core origin with a valid port, without credentials or an API path.")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path, "", ""))


def local_client_path(component: str) -> Path:
    path = ROOT / component / ".env"
    if path.is_symlink() or path.resolve().parent != ROOT.resolve() / component:
        raise ValueError("Linked client configuration cannot be edited here.")
    return path


def local_clients_snapshot() -> dict[str, Any]:
    with CONFIG_LOCK:
        digest = hashlib.sha256()
        clients = []
        for client_id, (component, key, restart) in LOCAL_CLIENTS.items():
            path = local_client_path(component)
            original = path.read_bytes() if path.is_file() else None
            digest.update(client_id.encode() + b"\0" + (original if original is not None else b"<missing>"))
            value = parse_env_file(path).get(key, "") if original is not None else ""
            try:
                safe = client_core_url(value, websocket=client_id == "hud") if value else ""
                editable = original is not None
            except ValueError:
                safe, editable = "", False
            clients.append({"id": client_id, "component": component, "key": key,
                            "url": safe, "editable": editable, "restart": restart})
        return {"revision": digest.hexdigest(), "clients": clients, "scope": str(ROOT)}


def preview_local_clients(payload: dict[str, Any]) -> dict[str, Any]:
    with CONFIG_LOCK:
        state = local_clients_snapshot()
        if payload.get("revision") != state["revision"]:
            raise ValueError("Local configuration changed. Reload and preview again.")
        selected = payload.get("clients")
        if (not isinstance(selected, list) or not selected or len(selected) > len(LOCAL_CLIENTS)
                or any(not isinstance(item, str) or item not in LOCAL_CLIENTS for item in selected)
                or len(set(selected)) != len(selected)):
            raise ValueError("Select known local clients once each.")
        core_url = client_core_url(payload.get("core_url"))
        changes = []
        for row in state["clients"]:
            if row["id"] not in selected:
                continue
            if not row["editable"]:
                raise ValueError("Selected client needs a regular, valid local .env first.")
            parsed = urllib.parse.urlsplit(core_url)
            after = (urllib.parse.urlunsplit(("wss" if parsed.scheme == "https" else "ws",
                     parsed.netloc, "/ws/hud", "", "")) if row["id"] == "hud" else core_url)
            if row["url"] == after:
                continue
            values = parse_env_file(local_client_path(row["component"]))
            if row["id"] == "wa" and values.get("LILY_CORE_ROUTER_URL", "").strip():
                raise ValueError("Local WA has an explicit LILY_CORE_ROUTER_URL. Clear or migrate that override manually first.")
            changes.append({**row, "before": row["url"] or "(unset)", "after": after})
        if not changes:
            raise ValueError("Selected clients already use this Core.")
        return {"revision": state["revision"], "core_url": core_url, "clients": selected,
                "changes": changes, "warnings": [
                    "Only this checkout changes. Remote devices and Android are untouched.",
                    "Existing credentials are preserved and will be sent to the new Core after restart/rebuild. Verify that destination and its token configuration.",
                    "No service is started or restarted. Process environment overrides and browser-saved settings may still take precedence.",
                    "This edits client destinations, not service bind ports or other WA vessel routes."]}


def apply_local_clients(payload: dict[str, Any]) -> dict[str, Any]:
    with CONFIG_LOCK:
        if payload.get("confirm") is not True:
            raise ValueError("Confirm the trusted Core destination first.")
        plan = preview_local_clients(payload)
        originals = {row["component"]: local_client_path(row["component"]).read_bytes()
                     for row in plan["changes"]}
        backup = RUNTIME_DIR / "client-backups" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + secrets.token_hex(4))
        backup.mkdir(parents=True, exist_ok=False)
        for component, data in originals.items():
            (backup / (component + ".env")).write_bytes(data)
        touched = []
        try:
            for row in plan["changes"]:
                component = row["component"]
                path = local_client_path(component)
                if path.read_bytes() != originals[component]:
                    raise ValueError("Configuration changed during apply. Reload and preview again.")
                update_env_file(path, {row["key"]: row["after"]})
                touched.append(component)
        except (OSError, ValueError) as error:
            for component in reversed(touched):
                path = local_client_path(component)
                temporary = path.with_suffix(".iris-rollback.tmp")
                temporary.write_bytes(originals[component])
                os.replace(temporary, path)
            raise ValueError("Client update failed; completed writes restored. Private backup retained.") from error
        return {"ok": True, "snapshot": local_clients_snapshot(), "changes": plan["changes"],
                "backup": str(backup.relative_to(ROOT))}


def executable_check(command: str) -> tuple[bool, str]:
    path = shutil.which(command)
    return (bool(path), path or "Not found in PATH")


def resolve_live2d_path(model_url: str) -> Path | None:
    parsed = urllib.parse.urlparse(model_url)
    if parsed.scheme in {"http", "https"}:
        return None
    relative = parsed.path.lstrip("/")
    return ROOT / "lily_private_realm" / "public" / relative


def dependency_checks() -> list[dict[str, Any]]:
    config = read_config()
    python_ready, python_detail = executable_check("py" if os.name == "nt" else "python3")
    node_ready, node_detail = executable_check("node")
    npm_ready, npm_detail = executable_check("npm.cmd" if os.name == "nt" else "npm")
    checks = [
        {"id": "python", "label": "Python runtime", "ready": python_ready, "required": True, "detail": python_detail},
        {"id": "node", "label": "Node.js runtime", "ready": node_ready, "required": True, "detail": node_detail},
        {"id": "npm", "label": "npm runtime", "ready": npm_ready, "required": True, "detail": npm_detail},
        {
            "id": "core_runtime",
            "label": "Core environment",
            "ready": (ROOT / "lily_essence_core" / "venv" / "Scripts" / "python.exe").exists(),
            "required": False,
            "detail": "Prepared" if (ROOT / "lily_essence_core" / "venv" / "Scripts" / "python.exe").exists() else "Installed automatically on first start",
        },
        {
            "id": "realm_runtime",
            "label": "Realm packages",
            "ready": (ROOT / "lily_private_realm" / "node_modules").exists(),
            "required": False,
            "detail": "Prepared" if (ROOT / "lily_private_realm" / "node_modules").exists() else "Installed automatically on first start",
        },
    ]
    if config["voice_mode"] == "local":
        sovits_ready = (ROOT / "tools" / "GPT-SoVITS" / "api.py").exists()
        checks.append(
            {
                "id": "sovits",
                "label": "GPT-SoVITS engine",
                "ready": sovits_ready,
                "required": True,
                "detail": "Local engine found" if sovits_ready else "Restore GPT-SoVITS locally; it is intentionally not stored in Git",
            }
        )
    model_path = resolve_live2d_path(config["live2d_model_url"])
    checks.append(
        {
            "id": "live2d",
            "label": "Live2D model",
            "ready": model_path is None or model_path.exists(),
            "required": True,
            "detail": "Remote model URL" if model_path is None else str(model_path.relative_to(ROOT)),
        }
    )
    checks.append(
        {
            "id": "owner_token",
            "label": "Owner token",
            "ready": config["owner_token_aligned"],
            "required": True,
            "detail": "Core and Realm match" if config["owner_token_aligned"] else "Enter one token in Setup so Core and Realm match",
        }
    )
    return checks


def tcp_ready(port: int, timeout: float = 0.25) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def http_url_ready(url: str, timeout: float = 0.7) -> bool:
    request = urllib.request.Request(url, headers={"User-Agent": "IRIS-Launcher/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return 200 <= response.status < 500
    except urllib.error.HTTPError as error:
        return error.code < 500
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def http_ready(port: int, path: str, timeout: float = 0.5) -> bool:
    return http_url_ready(f"http://127.0.0.1:{port}{path}", timeout=timeout)


def service_status(definition: ServiceDefinition, config: dict[str, Any]) -> dict[str, Any]:
    if definition.id == "core" and not local_host(config["core_url"]):
        health_url = f"{config['core_url'].rstrip('/')}/health/live"
        healthy = http_url_ready(health_url)
        return {
            "id": definition.id,
            "label": definition.label,
            "state": "online" if healthy else "offline",
            "detail": "Remote Core is reachable" if healthy else "Remote Core did not answer",
            "port": urllib.parse.urlparse(config["core_url"]).port or 80,
            "description": definition.description,
            "controllable": False,
            "location": "remote",
        }
    if definition.id == "voice" and config["voice_mode"] == "off":
        return {
            "id": definition.id,
            "label": definition.label,
            "state": "disabled",
            "detail": "Voice is disabled in this profile",
            "port": definition.port,
            "description": definition.description,
            "controllable": False,
            "location": "disabled",
        }
    if definition.id == "voice" and config["voice_mode"] == "remote":
        voice_base = config["voice_service_url"].split("/api/", 1)[0].rstrip("/")
        healthy = http_url_ready(f"{voice_base}/health/live") or http_url_ready(f"{voice_base}/health")
        return {
            "id": definition.id,
            "label": definition.label,
            "state": "online" if healthy else "offline",
            "detail": "Remote Voice Vessel is reachable" if healthy else "Remote Voice Vessel did not answer",
            "port": urllib.parse.urlparse(config["voice_service_url"]).port or 80,
            "description": definition.description,
            "controllable": False,
            "location": "remote",
        }

    listening = tcp_ready(definition.port)
    healthy = listening and http_ready(definition.port, definition.health_path)
    state = "online" if healthy else "starting" if listening else "offline"
    detail = f"Port {definition.port} is ready" if healthy else f"Port {definition.port} is opening" if listening else f"Port {definition.port} is closed"
    payload: dict[str, Any] = {
        "id": definition.id,
        "label": definition.label,
        "state": state,
        "detail": detail,
        "port": definition.port,
        "description": definition.description,
        "controllable": True,
        "location": "local",
    }
    if definition.id == "voice":
        engine = tcp_ready(10880)
        payload["engine_ready"] = engine
        if healthy and not engine:
            payload["state"] = "partial"
            payload["detail"] = "Voice Vessel is ready; GPT-SoVITS is still offline"
        elif engine and not listening:
            payload["state"] = "starting"
            payload["detail"] = "GPT-SoVITS is ready; Voice Vessel is still opening"
    return payload


def all_service_statuses() -> list[dict[str, Any]]:
    config = read_config()
    return [service_status(definition, config) for definition in SERVICE_DEFINITIONS.values()]


class JobManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._job: dict[str, Any] | None = None

    def snapshot(self) -> dict[str, Any] | None:
        with self._lock:
            return dict(self._job) if self._job else None

    def start(self, target: str, action: str) -> dict[str, Any]:
        with self._lock:
            if self._job and self._job["status"] == "running":
                raise RuntimeError("Another launcher action is still running")
            self._job = {
                "id": secrets.token_hex(6),
                "target": target,
                "action": action,
                "status": "running",
                "started_at": utc_now(),
                "finished_at": None,
                "output": "",
                "error": "",
            }
            snapshot = dict(self._job)
        threading.Thread(target=self._run, args=(target, action), daemon=True).start()
        return snapshot

    def _run(self, target: str, action: str) -> None:
        try:
            output = run_launcher_action(target, action)
            status = "done"
            error = ""
        except Exception as exc:  # noqa: BLE001 - job errors are reported to the local UI.
            output = ""
            status = "failed"
            error = str(exc)
        with self._lock:
            assert self._job is not None
            self._job.update(
                {
                    "status": status,
                    "finished_at": utc_now(),
                    "output": output[-12000:],
                    "error": error,
                }
            )


JOBS = JobManager()


def command_for(component: str, action: str) -> list[str]:
    if os.name != "nt":
        raise RuntimeError("IRIS process control is currently available on Windows only")
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        raise RuntimeError("Windows PowerShell was not found")
    return [
        powershell,
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        str(POWERSHELL_LAUNCHER),
        component,
        action,
    ]


def run_component(component: str, action: str) -> str:
    definition = SERVICE_DEFINITIONS[component]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    result = subprocess.run(
        command_for(definition.command, action),
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=900,
        creationflags=flags,
        check=False,
    )
    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    if result.returncode != 0:
        raise RuntimeError(output or f"{definition.label} command failed with exit code {result.returncode}")
    return output or f"{definition.label}: {action} command completed"


def launch_targets() -> list[str]:
    config = read_config()
    targets: list[str] = []
    if config["voice_mode"] == "local":
        targets.append("voice")
    if local_host(config["core_url"]):
        targets.append("core")
    targets.append("private")
    return targets


def run_launcher_action(target: str, action: str) -> str:
    if target not in {*SERVICE_DEFINITIONS, "all"}:
        raise ValueError("Unknown service target")
    if action not in {"start", "stop", "restart"}:
        raise ValueError("Unknown service action")
    config = read_config()
    if target == "core" and not local_host(config["core_url"]):
        raise ValueError("Core is configured on another device; start it from that host")
    if target == "voice" and config["voice_mode"] != "local":
        raise ValueError("Voice is not configured as a local service")
    targets = launch_targets() if target == "all" else [target]
    if action == "stop":
        targets = list(reversed(targets))
    outputs: list[str] = []
    for component in targets:
        outputs.append(f"$ {component} {action}")
        outputs.append(run_component(component, action))
    return "\n".join(outputs)


def recent_logs(max_lines: int = 80) -> str:
    candidates = []
    for component in ("private", "core", "voice", "sovits"):
        component_dir = ROOT / "logs" / component
        if component_dir.exists():
            candidates.extend(component_dir.glob("*.log"))
    existing = [path for path in candidates if path.is_file()]
    existing.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    output: list[str] = []
    for path in existing[:4]:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-max_lines:]
        except OSError:
            continue
        if lines:
            output.append(f"--- {path.relative_to(ROOT)} ---")
            output.extend(lines)
    return "\n".join(output)[-24000:]


def proxy_prompts(payload: dict[str, Any] | None = None, endpoint: str = "/api/prompts") -> dict[str, Any]:
    """Proxy only the configured Core prompt route; keep credentials server-side."""
    security_endpoint = endpoint in {
        "/api/security/vessels/requests",
        "/api/security/devices", "/api/security/devices/history",
        "/api/security/pairing/invitations", "/api/security/pairing/requests",
    } or bool(re.fullmatch(
        r"/api/security/(?:devices|pairing/requests|vessels/requests)/[a-f0-9]{32}/(?:revoke|approve|deny)", endpoint,
    ))
    if not security_endpoint and endpoint not in {"/api/system/runtime", "/api/prompts", "/api/devices", "/api/devices/preview", "/api/devices/apply", "/api/wa/secretary/settings", "/api/wa/secretary/status", "/api/wa/review", "/api/wa/review/draft", "/api/wa/review/approve", "/api/wa/review/resolve", "/api/wa/review/correct", "/api/wa/review/remind", "/api/wa/review/cancel-reminder"}:
        raise ValueError("Unsupported Core configuration endpoint")
    core_url = normalize_http_url(read_config()["core_url"], "Core URL").rstrip("/")
    core_env = parse_env_file(ROOT / "lily_essence_core/.env")
    token = core_env.get("LILY_OWNER_API_TOKEN", "")
    access = read_json(RUNTIME_DIR / "core-access.json", {})
    # A launcher-specific credential is bound to one exact configured Core URL.
    if access.get("core_url") == core_url and access.get("owner_token"):
        token = access["owner_token"]
    if not token:
        raise ValueError("Configure the Core owner token in Setup first.")
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    request = urllib.request.Request(core_url + endpoint,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30 if endpoint.startswith('/api/wa/review') else 8) as response:
            result = json.load(response)
        return {**result, "core_url": core_url}
    except urllib.error.HTTPError as error:
        if security_endpoint:
            try:
                detail = json.load(error).get("detail")
            except (ValueError, OSError):
                detail = None
            if isinstance(detail, str) and len(detail) <= 200:
                raise ValueError(detail) from None
            raise ValueError(f"Device security request failed ({error.code}).") from None
        if endpoint.startswith('/api/wa/review'):
            raise ValueError("Inbox action could not complete. Reload; check WhatsApp before retrying a send.") from None
        if endpoint == "/api/wa/secretary/settings":
            messages = {401: "Core rejected the owner token. Check Setup.",
                        404: "This Core needs the secretary settings update. Nothing was enabled.",
                        409: "Secretary settings changed elsewhere. Reload before saving.",
                        422: "Check number formats, duplicate numbers, and timing limits."}
            raise ValueError(messages.get(error.code, "Secretary settings could not be saved.")) from None
        if endpoint == "/api/wa/secretary/status":
            raise ValueError("WhatsApp Secretary status is unavailable. Check that Core and the personal WA vessel are current and connected.") from None
        if endpoint.startswith('/api/devices') and error.code in {409, 422}:
            try:
                detail = json.load(error).get('detail')
            except (ValueError, OSError):
                detail = None
            if isinstance(detail, str):
                raise ValueError(detail) from None
        messages = {401: "Core rejected the owner token. Check Setup.",
                    404: "This Core needs the prompt-editor update.",
                    409: "Prompts changed elsewhere. Reload before saving.",
                    422: "Invalid prompt. Keep all template variables and the length limit."}
        raise ValueError(messages.get(error.code, "Core prompt request failed.")) from None
    except (OSError, ValueError):
        raise ValueError("Core is unavailable. No configuration changes were saved.") from None


def bootstrap_payload() -> dict[str, Any]:
    return {
        "app": {"name": "IRIS Launcher", "version": "0.1.0", "root": str(ROOT)},
        "config": read_config(),
        "checks": dependency_checks(),
        "services": all_service_statuses(),
        "job": JOBS.snapshot(),
        "logs": recent_logs(35),
    }


def browser_proxy_target(prefix: str) -> tuple[str, dict[str, str]]:
    if prefix == "/core":
        base_url = client_core_url(read_config()["core_url"])
        core_env = parse_env_file(ROOT / "lily_essence_core/.env")
        access = read_json(RUNTIME_DIR / "core-access.json", {})
        token = core_env.get("LILY_OWNER_API_TOKEN", "") if local_host(base_url) else ""
        if access.get("core_url") == base_url and access.get("owner_token"):
            token = str(access["owner_token"])
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return base_url, headers
    if prefix == "/wa":
        control_env = parse_env_file(ROOT / "lily_control_center/.env")
        wa_env = parse_env_file(ROOT / "lily_wa_vessel/.env")
        base_url = client_core_url(control_env.get("VITE_BRIDGE_CONTROL_URL", "http://127.0.0.1:8091"))
        token = control_env.get("LILY_BROWSER_WA_TOKEN", "").strip() or wa_env.get("BRIDGE_CONTROL_TOKEN", "").strip()
        if not local_host(base_url) and not token:
            raise ValueError("Remote WA control requires a server-side browser token")
        headers = {"X-Lily-Token": token} if token else {}
        return base_url, headers
    if prefix == "/model":
        control_env = parse_env_file(ROOT / "lily_control_center/.env")
        model_env = parse_env_file(ROOT / "lily_model_vessel/.env")
        base_url = client_core_url(control_env.get("VITE_MODEL_VESSEL_URL", "http://127.0.0.1:10898"))
        token = control_env.get("LILY_BROWSER_MODEL_TOKEN", "").strip() or model_env.get("LILY_MODEL_VESSEL_TOKEN", "").strip()
        if not local_host(base_url) and not token:
            raise ValueError("Remote Model Vessel requires a server-side browser token")
        headers = {"X-Lily-Model-Token": token} if token else {}
        return base_url, headers
    raise ValueError("Unknown browser proxy target")


class IrisServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], session_token: str, csrf_token: str):
        super().__init__(address, handler)
        self.session_token = session_token
        self.csrf_token = csrf_token


class IrisHandler(BaseHTTPRequestHandler):
    server_version = "IRISLauncher/0.1"

    @property
    def iris_server(self) -> IrisServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, format: str, *args: Any) -> None:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        message = re.sub(r'([?&]token=)[^&\s"]+', r"\1[redacted]", format % args)
        with (RUNTIME_DIR / "server.log").open("a", encoding="utf-8") as stream:
            stream.write(f"{self.log_date_time_string()} {message}\n")

    def proxy_browser_request(self, method: str, parsed: urllib.parse.ParseResult) -> bool:
        match = re.fullmatch(r"/browser/(core|wa|model)(/.*)?", parsed.path)
        if not match:
            return False
        origin = self.headers.get("Origin", "").rstrip("/")
        if origin not in BROWSER_CLIENT_ORIGINS:
            self.send_json({"error": "Origin is not allowed"}, HTTPStatus.FORBIDDEN)
            return True
        if not self.authorized():
            self.send_json({"error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return True
        cookie_host = (self.headers.get("Host", "").split(":", 1)[0] or "").lower()
        if cookie_host not in {"127.0.0.1", "localhost"}:
            self.send_json({"error": "Invalid local host"}, HTTPStatus.FORBIDDEN)
            return True
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            self.send_json({"error": "Method not allowed"}, HTTPStatus.METHOD_NOT_ALLOWED)
            return True
        if method != "GET" and not secrets.compare_digest(
            self.headers.get("X-IRIS-CSRF", ""), self.iris_server.csrf_token
        ):
            self.send_json({"error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return True

        prefix, suffix = match.group(1), match.group(2) or "/"
        if suffix.startswith("/static/") or suffix.startswith("/models/"):
            self.send_json({"error": "Use the signed or public asset URL"}, HTTPStatus.FORBIDDEN)
            return True
        if prefix == "core" and not (suffix.startswith("/api/") or suffix == "/health"):
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return True
        if prefix == "wa" and not (suffix.startswith("/api/") or suffix.startswith("/health")):
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return True
        if prefix == "model" and not (suffix.startswith("/api/") or suffix == "/health"):
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return True

        response_started = False
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > PROXY_MAX_BODY_BYTES:
                raise ValueError("Request body exceeds the browser proxy limit")
            payload = self.rfile.read(length) if length else None
            base_url, upstream_headers = browser_proxy_target(f"/{prefix}")
            content_type = self.headers.get("Content-Type", "").strip()
            if content_type:
                upstream_headers["Content-Type"] = content_type
            last_event_id = self.headers.get("Last-Event-ID", "").strip()
            if last_event_id and suffix == "/api/events/stream":
                upstream_headers["Last-Event-ID"] = last_event_id
            target = base_url.rstrip("/") + suffix
            if parsed.query:
                target += "?" + parsed.query
            request = urllib.request.Request(target, data=payload, headers=upstream_headers, method=method)
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    return None

            try:
                upstream = urllib.request.build_opener(NoRedirect).open(request, timeout=65)
            except urllib.error.HTTPError as error:
                upstream = error
            with upstream:
                response_type = upstream.headers.get("Content-Type", "application/json")
                streaming = suffix == "/api/events/stream" and method == "GET"
                body = b""
                if not streaming:
                    body = upstream.read(18 * 1024 * 1024 + 1)
                    if len(body) > 18 * 1024 * 1024:
                        raise ValueError("Upstream response exceeds the browser proxy limit")
                self.send_response(upstream.status)
                self.send_header("Content-Type", response_type)
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Credentials", "true")
                self.send_header("Vary", "Origin")
                if streaming:
                    self.end_headers()
                    response_started = True
                    read_chunk = getattr(upstream, "read1", None) or (lambda _size: upstream.read(1))
                    while chunk := read_chunk(8192):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                else:
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    response_started = True
                    self.wfile.write(body)
        except (OSError, ValueError, urllib.error.URLError) as error:
            if not response_started and not self.wfile.closed:
                try:
                    self.send_json({"error": "Browser proxy request failed"}, HTTPStatus.BAD_GATEWAY)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            self.log_message("browser proxy failed: %s", type(error).__name__)
        return True

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API.
        parsed = urllib.parse.urlparse(self.path)
        if not re.fullmatch(r"/browser/(core|wa|model)(/.*)?", parsed.path):
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        origin = self.headers.get("Origin", "").rstrip("/")
        if origin not in BROWSER_CLIENT_ORIGINS:
            self.send_json({"error": "Origin is not allowed"}, HTTPStatus.FORBIDDEN)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Last-Event-ID,X-IRIS-CSRF")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API.
        parsed = urllib.parse.urlparse(self.path)
        if self.proxy_browser_request("GET", parsed):
            return
        if parsed.path == "/api/ping":
            self.send_json({"app": "iris-launcher", "ok": True})
            return
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/" and query.get("token", [""])[0] == self.iris_server.session_token:
            redirect_target = "/?native=1" if query.get("native", [""])[0] == "1" else "/"
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", redirect_target)
            self.send_header(
                "Set-Cookie",
                f"iris_session={self.iris_server.session_token}; HttpOnly; SameSite=Strict; Path=/",
            )
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if parsed.path == "/api/browser-session":
            origin = self.headers.get("Origin", "").rstrip("/")
            if origin not in BROWSER_CLIENT_ORIGINS:
                self.send_json({"error": "Origin is not allowed"}, HTTPStatus.FORBIDDEN)
                return
            cookie_host = (self.headers.get("Host", "").split(":", 1)[0] or "").lower()
            if not self.authorized() or cookie_host not in {"127.0.0.1", "localhost"}:
                self.send_json({"error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
                return
            self.send_json({"csrf": self.iris_server.csrf_token})
            return
        if parsed.path.startswith("/api/"):
            if not self.authorized():
                self.send_json({"error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
                return
            if parsed.path == "/api/bootstrap":
                self.send_json(bootstrap_payload())
                return
            if parsed.path == "/api/vessel-setup":
                try:
                    self.send_json(VESSEL_SETUP.snapshot())
                except (OSError, ValueError):
                    self.send_json({"error": "Device management storage is unavailable."}, HTTPStatus.BAD_REQUEST)
                return
            if parsed.path == "/api/google-contacts":
                try:
                    self.send_json(GOOGLE_CONTACTS.status())
                except ValueError as error:
                    self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
                return
            if parsed.path == "/api/status":
                self.send_json({"services": all_service_statuses(), "job": JOBS.snapshot()})
                return
            if parsed.path == "/api/logs":
                self.send_json({"logs": recent_logs()})
                return
            if parsed.path == "/api/prompts":
                try:
                    self.send_json(proxy_prompts())
                except ValueError as error:
                    self.send_json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
                return
            if parsed.path in {"/api/wa/secretary/settings", "/api/wa/secretary/status", "/api/wa/review"}:
                try:
                    self.send_json(proxy_prompts(endpoint=parsed.path))
                except ValueError as error:
                    self.send_json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
                return
            if parsed.path in {"/api/security/devices", "/api/security/devices/history", "/api/security/pairing/requests", "/api/security/vessels/requests"}:
                try:
                    self.send_json(proxy_prompts(endpoint=parsed.path))
                except ValueError as error:
                    self.send_json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
                return
            if parsed.path == "/api/device-updates":
                self.send_json(device_updates_snapshot(ROOT, VESSEL_SETUP, lambda: proxy_prompts(endpoint="/api/system/runtime")))
                return
            if parsed.path == "/api/devices":
                try:
                    self.send_json(proxy_prompts(endpoint="/api/devices"))
                except ValueError as error:
                    self.send_json({"error": str(error)}, HTTPStatus.BAD_GATEWAY)
                return
            if parsed.path == "/api/local-clients":
                try:
                    self.send_json(local_clients_snapshot())
                except (OSError, ValueError):
                    self.send_json({"error": "Could not read local client configuration."}, HTTPStatus.BAD_REQUEST)
                return
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API.
        parsed = urllib.parse.urlparse(self.path)
        if self.proxy_browser_request("POST", parsed):
            return
        if not self.authorized(require_csrf=True):
            self.send_json({"error": "Unauthorized"}, HTTPStatus.UNAUTHORIZED)
            return
        try:
            payload = self.read_json_body()
            if parsed.path == '/api/wa/secretary/simulate':
                python = ROOT / 'lily_essence_core' / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
                try:
                    result = subprocess.run(
                        [str(python), str(ROOT / 'iris_launcher' / 'secretary_simulator.py')],
                        input=json.dumps(payload), capture_output=True, text=True, encoding='utf-8',
                        timeout=35, cwd=str(ROOT / 'lily_essence_core'),
                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                    )
                    data = json.loads(result.stdout)
                    self.send_json(data, HTTPStatus.OK if result.returncode == 0 else HTTPStatus.BAD_REQUEST)
                except (OSError, subprocess.TimeoutExpired, ValueError):
                    self.send_json({'error': 'Local simulator unavailable. Check the Core virtual environment and LLM configuration.'}, HTTPStatus.SERVICE_UNAVAILABLE)
                return
            if parsed.path.startswith("/api/vessel-setup/"):
                actions = {"bind": VESSEL_SETUP.bind, "operate": VESSEL_SETUP.start}
                action = actions.get(parsed.path.removeprefix("/api/vessel-setup/"))
                if action is None:
                    raise ValueError("Unknown device setup action")
                try:
                    self.send_json(action(payload))
                except (OSError, KeyError):
                    self.send_json({"error": "Device setup state is unavailable. Refresh and check the device."}, HTTPStatus.BAD_REQUEST)
                return
            if parsed.path.startswith("/api/google-contacts/"):
                actions = {
                    "configure": lambda: GOOGLE_CONTACTS.configure(payload),
                    "connect": GOOGLE_CONTACTS.connect,
                    "sync": GOOGLE_CONTACTS.sync,
                    "disconnect": GOOGLE_CONTACTS.disconnect,
                }
                action = actions.get(parsed.path.removeprefix("/api/google-contacts/"))
                if action is None:
                    raise ValueError("Unknown Google Contacts action")
                try:
                    self.send_json(action())
                except OSError:
                    self.send_json({"error": "Google Contacts local storage is unavailable."}, HTTPStatus.BAD_REQUEST)
                return
            if parsed.path in {"/api/wa/secretary/settings", "/api/wa/review/draft", "/api/wa/review/approve", "/api/wa/review/resolve", "/api/wa/review/correct", "/api/wa/review/remind", "/api/wa/review/cancel-reminder"}:
                self.send_json(proxy_prompts(payload, parsed.path))
                return
            if parsed.path == "/api/security/pairing/invitations" or re.fullmatch(
                r"/api/security/(?:devices/[a-f0-9]{32}/revoke|pairing/requests/[a-f0-9]{32}/(?:approve|deny)|vessels/requests/[a-f0-9]{32}/(?:approve|deny|revoke))",
                parsed.path,
            ):
                self.send_json(proxy_prompts(payload, parsed.path))
                return
            if parsed.path in {"/api/local-clients/preview", "/api/local-clients/apply"}:
                handler = apply_local_clients if parsed.path.endswith("/apply") else preview_local_clients
                try:
                    self.send_json(handler(payload))
                except OSError:
                    self.send_json({"error": "Local configuration access failed. Check file permissions and private backups."}, HTTPStatus.BAD_REQUEST)
                return
            if parsed.path in {"/api/devices/preview", "/api/devices/apply"}:
                self.send_json(proxy_prompts(payload, parsed.path))
                return
            if parsed.path == "/api/prompts":
                self.send_json(proxy_prompts(payload))
                return
            if parsed.path == "/api/setup":
                config = save_setup(payload)
                self.send_json({"ok": True, "config": config, "checks": dependency_checks()})
                return
            if parsed.path == "/api/action":
                job = JOBS.start(str(payload.get("target", "")), str(payload.get("action", "")))
                self.send_json({"ok": True, "job": job}, HTTPStatus.ACCEPTED)
                return
            if parsed.path == "/api/open":
                target = str(payload.get("target", ""))
                destinations = {"private": "http://127.0.0.1:5230/"}
                if target not in destinations:
                    raise ValueError("Unknown launcher destination")
                webbrowser.open(destinations[target])
                self.send_json({"ok": True})
                return
            if parsed.path == "/api/quit":
                self.send_json({"ok": True})
                threading.Thread(target=self.iris_server.shutdown, daemon=True).start()
                return
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except (ValueError, RuntimeError, FileNotFoundError) as error:
            self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON body"}, HTTPStatus.BAD_REQUEST)

    def do_PUT(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API.
        if not self.proxy_browser_request("PUT", urllib.parse.urlparse(self.path)):
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_PATCH(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API.
        if not self.proxy_browser_request("PATCH", urllib.parse.urlparse(self.path)):
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API.
        if not self.proxy_browser_request("DELETE", urllib.parse.urlparse(self.path)):
            self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def read_json_body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid content length") from error
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("Invalid request body size")
        body = self.rfile.read(length).decode("utf-8")
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        return payload

    def authorized(self, require_csrf: bool = False) -> bool:
        cookies = SimpleCookie(self.headers.get("Cookie", ""))
        session = cookies.get("iris_session")
        if not session or not secrets.compare_digest(session.value, self.iris_server.session_token):
            return False
        if require_csrf:
            supplied = self.headers.get("X-IRIS-CSRF", "")
            if not secrets.compare_digest(supplied, self.iris_server.csrf_token):
                return False
            request_origin = self.headers.get("Origin", "")
            if request_origin:
                parsed = urllib.parse.urlparse(request_origin)
                if parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.port != self.iris_server.server_port:
                    return False
        return True

    def serve_static(self, request_path: str) -> None:
        if request_path == "/":
            if not self.authorized():
                self.send_error(HTTPStatus.FORBIDDEN, "Open IRIS Launcher from its start script")
                return
            source = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
            body = source.replace("__IRIS_CSRF_TOKEN__", self.iris_server.csrf_token).encode("utf-8")
            self.send_bytes(body, "text/html; charset=utf-8")
            return
        relative = request_path.lstrip("/")
        if relative not in {"styles.css", "app.js", "prompts.js", "devices.js", "pairing.js", "clients.js", "secretary.js", "secretary-simulator.js", "inbox-review.js", "google-contacts.js", "vessel-setup.js"}:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        path = STATIC_DIR / relative
        content_type = "text/css; charset=utf-8" if path.suffix == ".css" else "text/javascript; charset=utf-8"
        self.send_bytes(path.read_bytes(), content_type)

    def send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_bytes(json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def send_bytes(self, body: bytes, content_type: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if urllib.parse.urlparse(self.path).path == "/api/browser-session" or self.path.startswith("/browser/"):
            origin = self.headers.get("Origin", "").rstrip("/")
            if origin in BROWSER_CLIENT_ORIGINS:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Credentials", "true")
                self.send_header("Vary", "Origin")
        native_host = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("native", [""])[0] == "1"
        native_ipc = " ipc: http://ipc.localhost" if native_host else ""
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; "
            f"connect-src 'self'{native_ipc}; frame-ancestors 'none'",
        )
        self.end_headers()
        self.wfile.write(body)


def open_existing(port: int) -> bool:
    session = read_json(SESSION_PATH, {})
    token = str(session.get("token") or "")
    if not token:
        return False
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=0.5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return False
    if payload.get("app") != "iris-launcher":
        return False
    webbrowser.open(f"http://127.0.0.1:{port}/?token={urllib.parse.quote(token)}")
    return True


def serve(host: str, port: int, *, open_browser: bool = True) -> int:
    if host not in {"127.0.0.1", "localhost"}:
        raise ValueError("IRIS Launcher must bind to loopback")
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(24)
    try:
        server = IrisServer((host, port), IrisHandler, token, csrf)
    except OSError:
        if open_browser and open_existing(port):
            return 0
        raise

    from scripts.runtime_status import track_start
    track_start("iris_launcher")
    write_json_atomic(SESSION_PATH, {"token": token, "pid": os.getpid(), "port": port, "started_at": utc_now()})
    url = f"http://127.0.0.1:{port}/?token={urllib.parse.quote(token)}"
    if open_browser:
        threading.Timer(0.45, lambda: webbrowser.open(url)).start()
    print(f"IRIS Launcher is ready at http://127.0.0.1:{port}/")
    try:
        server.serve_forever(poll_interval=0.4)
    finally:
        server.server_close()
        try:
            SESSION_PATH.unlink()
        except FileNotFoundError:
            pass
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Launch the local IRIS setup and service dashboard.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    try:
        return serve(args.host, args.port, open_browser=not args.no_browser)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
