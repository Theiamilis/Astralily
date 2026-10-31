"""Public Edition credential edges for the vessels shipped in this snapshot."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Vessel:
    folder: str
    token: str
    port_key: str
    port: int
    consumers: tuple[tuple[str, str], ...]


VESSELS = {
    "home": Vessel("lily_home_vessel", "LILY_HOME_VESSEL_TOKEN", "LILY_HOME_VESSEL_PORT", 10896,
                   (("core", "LILY_HOME_VESSEL_TOKEN"),)),
    "tool": Vessel("lily_tool_vessel", "LILY_TOOL_VESSEL_TOKEN", "LILY_TOOL_VESSEL_PORT", 8092,
                   (("core", "LILY_TOOL_AGENT_TOKEN"), ("core", "LILY_DEVICE_POWER_EXECUTOR_TOKEN"))),
    "stt": Vessel("lily_stt_vessel", "LILY_STT_VESSEL_TOKEN", "LILY_STT_VESSEL_PORT", 10894,
                  (("core", "LILY_STT_SERVICE_TOKEN"), ("wa", "LILY_STT_TOKEN"))),
    "voice": Vessel("lily_voice_vessel", "LILY_VOICE_VESSEL_TOKEN", "LILY_VOICE_VESSEL_PORT", 10881,
                    (("core", "LILY_VOICE_SERVICE_TOKEN"),)),
    "model": Vessel("lily_model_vessel", "LILY_MODEL_VESSEL_TOKEN", "LILY_MODEL_VESSEL_PORT", 10898,
                    (("browser", "LILY_BROWSER_MODEL_TOKEN"),)),
}
FOLDERS = {key: value.folder for key, value in VESSELS.items()}
FOLDERS.update(core="lily_essence_core", wa="lily_wa_vessel", browser="lily_control_center")
PROFILES = {
    "always-on": ["core", "wa", "home", "tool", "stt"],
    "voice-gpu": ["voice", "model"],
    "desktop": ["browser", "model"],
}
SETUP_FIELDS = {
    "core": {"LILY_OPENAI_COMPAT_BASE": "LLM endpoint", "LILY_OPENAI_COMPAT_BRAIN_MODEL": "LLM model"},
    "wa": {"LILY_CORE_URL": "Core URL"},
    "home": {"LILY_HOME_DEVICES": "Home devices (id=wiz,IP; see vessel README)"},
    "stt": {"LILY_STT_MODEL": "Whisper model", "LILY_STT_DEVICE": "cpu or cuda"},
    "voice": {"GPTSOVITS_API_URL": "GPT-SoVITS engine URL"},
    "tool": {},
    "model": {},
    "browser": {},
}


def token_keys(component):
    keys = {v.token for name, v in VESSELS.items() if name == component}
    keys.update(key for v in VESSELS.values() for target, key in v.consumers if target == component)
    return keys
