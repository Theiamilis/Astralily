"""Owner-managed runtime settings for the Lily Core control surface."""

from __future__ import annotations

import json
import os
from threading import RLock
from pathlib import Path
from typing import Any


SETTINGS_LOCK = RLock()

RUNTIME_SETTING_FIELDS: dict[str, dict[str, Any]] = {
    "tool_agent_mode": {"label": "Tool execution location", "section": "modules"},
    "voice_service_registry": {"label": "Voice registry", "section": "speech", "secret": True},
    "brain_provider": {"label": "Brain provider", "section": "providers"},
    "openai_compat_base": {"label": "OpenAI-compatible URL", "section": "providers", "url": True},
    "openai_compat_api_key": {"label": "OpenAI-compatible API key", "section": "providers", "secret": True},
    "openai_compat_brain_model": {"label": "OpenAI-compatible brain model", "section": "providers"},
    "stream_stage_vision_base": {"label": "Vision provider URL", "section": "providers", "url": True},
    "stream_stage_vision_api_key": {"label": "Vision provider API key", "section": "providers", "secret": True},
    "stream_stage_vision_model": {"label": "Vision model", "section": "providers"},
    "claude_api_key": {"label": "Claude API key", "section": "providers", "secret": True},
    "claude_model": {"label": "Claude model", "section": "providers"},
    "gemini_api_key": {"label": "Gemini API key", "section": "providers", "secret": True},
    "gemini_model": {"label": "Gemini model", "section": "providers"},
    "voice_provider": {"label": "Default voice route", "section": "speech"},
    "voice_language": {"label": "Voice language", "section": "speech"},
    "voice_profile": {"label": "Voice profile", "section": "speech"},
    "voice_service_url": {"label": "SoVITS service URL", "section": "speech", "url": True},
    "voice_service_health_url": {"label": "SoVITS health URL", "section": "speech", "url": True},
    "voice_service_token": {"label": "SoVITS service token", "section": "speech", "secret": True},
    "alibaba_api_key": {"label": "Alibaba API key", "section": "speech", "secret": True},
    "alibaba_model": {"label": "Alibaba speech model", "section": "speech"},
    "alibaba_voice_id": {"label": "Alibaba voice ID", "section": "speech"},
    "alibaba_workspace_id": {"label": "Alibaba workspace ID", "section": "speech"},
    "alibaba_region": {"label": "Alibaba region", "section": "speech"},
    "alibaba_instruction": {"label": "Alibaba voice style", "section": "speech"},
    "stream_voice_service_url": {"label": "Stream voice service URL", "section": "speech", "url": True},
    "stream_voice_service_health_url": {"label": "Stream voice health URL", "section": "speech", "url": True},
    "stream_voice_service_token": {"label": "Stream voice service token", "section": "speech", "secret": True},
    "stt_service_url": {"label": "STT service URL", "section": "speech", "url": True},
    "stt_service_token": {"label": "STT service token", "section": "speech", "secret": True},
    "listener_nodes_json": {"label": "Listener registry", "section": "modules", "secret": True},
    "home_vessel_url": {"label": "Home Vessel URL", "section": "modules", "url": True},
    "home_vessel_token": {"label": "Home Vessel token", "section": "modules", "secret": True},
    "finance_vessel_url": {"label": "Finance Vessel URL", "section": "modules", "url": True},
    "finance_vessel_token": {"label": "Finance Vessel token", "section": "modules", "secret": True},
    "tool_agent_url": {"label": "Tool Vessel URL", "section": "modules", "url": True},
    "tool_agent_health_url": {"label": "Tool Vessel health URL", "section": "modules", "url": True},
    "tool_agent_token": {"label": "Tool Vessel token", "section": "modules", "secret": True},
}

MODULE_CATALOG: tuple[dict[str, str], ...] = (
    {"id": "voice", "label": "SoVITS voice", "description": "Local or remote GPT-SoVITS speech synthesis."},
    {"id": "stream_voice", "label": "Stream voice", "description": "Google/Edge voice plus RVC for Stream Stage."},
    {"id": "stt", "label": "Speech recognition", "description": "fLily-Voice-Host-whisper transcription for voice input."},
    {"id": "tools", "label": "Hermes / OpenClaw", "description": "Tool execution and document tasks."},
    {"id": "file", "label": "File Vessel", "description": "Whitelisted lightweight file operations."},
    {"id": "home", "label": "Home Vessel", "description": "Smart-home and WiZ controls."},
    {"id": "finance", "label": "Finance Vessel", "description": "Private ledger and finance drafts."},
    {"id": "tiktok", "label": "TikTok bridge", "description": "Live event collection for Stream Stage."},
)

_MODULE_ALIASES = {"openclaw": "tools"}


def runtime_settings_path() -> Path:
    core_root = Path(__file__).resolve().parent.parent
    return Path(
        os.getenv("LILY_RUNTIME_SETTINGS_PATH", str(core_root / "runtime" / "lily_settings.json"))
    ).expanduser()


def load_runtime_overrides(path: Path | None = None) -> dict[str, Any]:
    target = path or runtime_settings_path()
    try:
        decoded = json.loads(target.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}
    return decoded if isinstance(decoded, dict) else {}


def save_runtime_overrides(overrides: dict[str, Any], path: Path | None = None) -> Path:
    target = path or runtime_settings_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.tmp")
    temporary.write_text(json.dumps(overrides, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, target)
    try:
        target.chmod(0o600)
    except OSError:
        pass
    return target


def _normalise_module_id(value: Any) -> str:
    raw = str(value or "").strip().lower().replace("-", "_")
    return _MODULE_ALIASES.get(raw, raw)


def apply_runtime_overrides(core_settings: Any, overrides: dict[str, Any]) -> None:
    for key, value in overrides.items():
        if key not in RUNTIME_SETTING_FIELDS or not hasattr(core_settings, key):
            continue
        metadata = RUNTIME_SETTING_FIELDS[key]
        if metadata.get("secret") or isinstance(getattr(core_settings, key), str):
            setattr(core_settings, key, str(value or "").strip())
        else:
            setattr(core_settings, key, value)

    disabled = overrides.get("disabled_components")
    if isinstance(disabled, list):
        core_settings.disabled_components = {
            _normalise_module_id(item) for item in disabled if _normalise_module_id(item)
        }


def update_runtime_settings(core_settings: Any, values: dict[str, Any]) -> list[str]:
    with SETTINGS_LOCK:
        return _update_runtime_settings(core_settings, values)


def _update_runtime_settings(core_settings: Any, values: dict[str, Any]) -> list[str]:
    if not isinstance(values, dict):
        raise ValueError("Settings values must be an object.")
    if "tool_agent_mode" in values and values["tool_agent_mode"] not in ("local", "remote"):
        raise ValueError("Tool execution location must be local or remote.")
    if "voice_service_registry" in values:
        from .voice_registry import parse_voice_nodes
        try:
            raw = values["voice_service_registry"]
            if not isinstance(raw, str) or len(raw) > 64000:
                raise ValueError()
            parse_voice_nodes(raw, legacy_url="", legacy_health_url="", legacy_token="", default_timeout_seconds=180)
        except (ValueError, TypeError):
            raise ValueError("Invalid voice registry configuration.") from None
    if "listener_nodes_json" in values:
        from .listener_routes import parse_node_registry
        try:
            raw = values["listener_nodes_json"]
            if not isinstance(raw, str) or len(raw) > 64_000:
                raise ValueError()
            parse_node_registry(raw)
        except (ValueError, TypeError):
            raise ValueError("Invalid Listener registry configuration.") from None
    unknown = sorted(key for key in values if key not in RUNTIME_SETTING_FIELDS and key != "disabled_components")
    if unknown:
        raise ValueError(f"Unknown settings field: {unknown[0]}")

    overrides = load_runtime_overrides(core_settings.runtime_settings_path)
    changed: list[str] = []
    for key, value in values.items():
        if key == "disabled_components":
            if not isinstance(value, list):
                raise ValueError("disabled_components must be a list.")
            normalised = sorted({_normalise_module_id(item) for item in value if _normalise_module_id(item)})
            allowed = {item["id"] for item in MODULE_CATALOG}
            invalid = sorted(set(normalised) - allowed)
            if invalid:
                raise ValueError(f"Unknown module: {invalid[0]}")
            if overrides.get(key) != normalised:
                overrides[key] = normalised
                changed.append(key)
            continue

        metadata = RUNTIME_SETTING_FIELDS[key]
        if metadata.get("secret") or metadata.get("url") or isinstance(value, str):
            normalised_value: Any = str(value or "").strip()
        else:
            raise ValueError(f"Invalid value for settings field: {key}")
        if overrides.get(key) != normalised_value:
            overrides[key] = normalised_value
            changed.append(key)

    if changed:
        save_runtime_overrides(overrides, core_settings.runtime_settings_path)
        core_settings.reload_runtime_overrides()
    return changed


def _configured(value: Any) -> bool:
    return bool(str(value or "").strip())


def settings_snapshot(core_settings: Any, health: dict[str, Any] | None = None) -> dict[str, Any]:
    providers: list[dict[str, Any]] = []
    speech: list[dict[str, Any]] = []
    for key, metadata in RUNTIME_SETTING_FIELDS.items():
        section = metadata["section"]
        if section not in {"providers", "speech"}:
            continue
        item: dict[str, Any] = {
            "key": key,
            "label": metadata["label"],
            "section": section,
            "secret": bool(metadata.get("secret")),
            "configured": _configured(getattr(core_settings, key, "")),
        }
        if not metadata.get("secret"):
            item["value"] = str(getattr(core_settings, key, "") or "")
        (speech if section == "speech" else providers).append(item)

    health = health or {}
    service_settings = {
        "voice": "voice_service_url",
        "stream_voice": "stream_voice_service_url",
        "stt": "stt_service_url",
        "tools": "tool_agent_url",
        "home": "home_vessel_url",
        "finance": "finance_vessel_url",
    }
    modules: list[dict[str, Any]] = []
    for module in MODULE_CATALOG:
        module_id = module["id"]
        component_id = "openclaw" if module_id == "tools" else module_id
        url_key = service_settings.get(module_id)
        module_health = health.get(component_id) if isinstance(health.get(component_id), dict) else {}
        token_key = url_key.replace("_url", "_token") if url_key else ""
        module_status = module_health.get("status")
        if not module_status:
            module_status = "configured" if url_key and _configured(getattr(core_settings, url_key, "")) else "unconfigured"
        modules.append(
            {
                **module,
                "enabled": not core_settings.is_component_disabled(module_id),
                "required": core_settings.is_component_required(component_id),
                "status": module_status,
                "url": str(getattr(core_settings, url_key, "") or "") if url_key else "",
                "setting_key": url_key,
                "token_key": token_key,
                "token_configured": _configured(getattr(core_settings, token_key, "")) if token_key else False,
            }
        )

    return {
        "schema_version": 1,
        "runtime_overrides": bool(core_settings.runtime_overrides),
        "providers": providers,
        "speech": speech,
        "modules": modules,
        "required_components": sorted(core_settings.required_components),
        "disabled_components": sorted(core_settings.disabled_components),
        "security": {
            "owner_auth_configured": bool(core_settings.owner_api_token),
            "owner_auth_enforced": bool(core_settings.owner_api_token_enforced),
            "secrets_returned": False,
        },
    }
