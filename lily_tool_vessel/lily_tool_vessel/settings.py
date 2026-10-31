import os
from pathlib import Path

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


class ToolVesselSettings:
    @staticmethod
    def _parse_bool(raw_value: str, fallback: bool = False) -> bool:
        if raw_value.strip() == "":
            return fallback
        return raw_value.strip().lower() in {"1", "true", "yes", "on", "enabled"}

    @staticmethod
    def _parse_csv(raw_value: str, fallback_values: list[str]) -> list[str]:
        if raw_value.strip():
            return [item.strip().lower() for item in raw_value.split(",") if item.strip()]
        return [item.strip().lower() for item in fallback_values if item and item.strip()]

    def __init__(self) -> None:
        self.host = os.getenv("LILY_TOOL_VESSEL_HOST", "127.0.0.1").strip() or "127.0.0.1"
        self.port = int(os.getenv("LILY_TOOL_VESSEL_PORT", "8092"))
        self.token = os.getenv("LILY_TOOL_VESSEL_TOKEN", "").strip()
        self.provider = os.getenv("LILY_TOOL_AGENT_PROVIDER", "hermes").strip().lower() or "hermes"
        self.fallback_enabled = self._parse_bool(os.getenv("LILY_TOOL_FALLBACK_ENABLED", "true"), True)
        self.fallback_chain = self._parse_csv(
            os.getenv("LILY_TOOL_AGENT_FALLBACK_CHAIN", ""),
            ["hermes", "openclaw"],
        )
        self.timeout_seconds = int(os.getenv("LILY_TOOL_TIMEOUT_SECONDS", "180"))
        self.workdir = os.getenv("LILY_TOOL_WORKDIR", str(BASE_DIR.parent)).strip()
        self.hermes_cli = os.getenv("LILY_HERMES_CLI", "hermes").strip() or "hermes"
        self.openclaw_cli = os.getenv("LILY_OPENCLAW_CLI", "openclaw").strip() or "openclaw"
        self.hermes_home = os.getenv("HERMES_HOME", "").strip()
        self.openclaw_home = os.getenv("OPENCLAW_HOME", "").strip()
        self.device_power_topology = os.getenv(
            "LILY_DEVICE_POWER_TOPOLOGY",
            str(BASE_DIR.parent / "config" / "topology.json"),
        ).strip()
        self.device_power_ssh_timeout_seconds = int(os.getenv("LILY_DEVICE_POWER_SSH_TIMEOUT_SECONDS", "12"))
        self.device_power_audit_path = os.getenv(
            "LILY_DEVICE_POWER_AUDIT_PATH",
            str(BASE_DIR / "runtime" / "device_power_audit.jsonl"),
        ).strip()
        self.device_power_watcher_timeout_seconds = int(
            os.getenv("LILY_DEVICE_POWER_WATCHER_TIMEOUT_SECONDS", "300")
        )
        self.device_power_watcher_poll_seconds = max(
            2,
            int(os.getenv("LILY_DEVICE_POWER_WATCHER_POLL_SECONDS", "5")),
        )
        self.device_power_event_url = os.getenv(
            "LILY_DEVICE_POWER_EVENT_URL",
            "http://127.0.0.1:8000/api/power/events",
        ).strip()
        self.artifact_dir = os.getenv("LILY_TOOL_ARTIFACT_DIR", str(BASE_DIR / "runtime" / "artifacts")).strip()
        self.artifact_max_bytes = int(os.getenv("LILY_TOOL_ARTIFACT_MAX_BYTES", str(20 * 1024 * 1024)))
        self.artifact_allowed_extensions = self._parse_csv(
            os.getenv("LILY_TOOL_ARTIFACT_ALLOWED_EXTENSIONS", ""),
            ["png", "jpg", "jpeg", "webp", "gif", "pdf", "docx", "xlsx", "txt", "md", "zip"],
        )
        self.artifact_allowed_extensions = [
            extension if extension.startswith(".") else f".{extension}"
            for extension in self.artifact_allowed_extensions
        ]
        self.input_max_bytes = int(os.getenv("LILY_TOOL_INPUT_MAX_BYTES", str(self.artifact_max_bytes)))
        self.input_allowed_extensions = self._parse_csv(
            os.getenv("LILY_TOOL_INPUT_ALLOWED_EXTENSIONS", ""),
            ["pdf"],
        )
        self.input_allowed_extensions = [
            extension if extension.startswith(".") else f".{extension}"
            for extension in self.input_allowed_extensions
        ]


settings = ToolVesselSettings()
