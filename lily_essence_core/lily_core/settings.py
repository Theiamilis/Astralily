import json
import os
from pathlib import Path
from dotenv import load_dotenv

from .runtime_settings import apply_runtime_overrides, load_runtime_overrides, runtime_settings_path
from .voice_registry import parse_voice_nodes

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


class LilyCoreSettings:
    VOICE_ROUTES = {"sovits", "sovits2", "rvc", "alibaba"}
    COMPONENT_IDS = {
        "core",
        "stage",
        "brain",
        "vision",
        "voice",
        "stream_voice",
        "stt",
        "tiktok",
        "openclaw",
        "file",
        "home",
        "finance",
    }

    @staticmethod
    def _parse_provider_chain(raw_value: str, fallback_values: list[str]) -> list[str]:
        if raw_value.strip():
            return [item.strip().lower() for item in raw_value.split(",") if item.strip()]
        return [item.strip().lower() for item in fallback_values if item and item.strip()]

    @staticmethod
    def _parse_csv(raw_value: str, fallback_values: list[str]) -> list[str]:
        if raw_value.strip():
            return [item.strip().lower() for item in raw_value.split(",") if item.strip()]
        return [item.strip().lower() for item in fallback_values if item and item.strip()]

    @staticmethod
    def _parse_bool(raw_value: str, fallback: bool = False) -> bool:
        if raw_value.strip() == "":
            return fallback
        return raw_value.strip().lower() in {"1", "true", "yes", "on", "enabled"}

    def __init__(self) -> None:
        self.runtime_settings_path = runtime_settings_path()
        self.runtime_overrides = load_runtime_overrides(self.runtime_settings_path)
        self.required_components = {
            item.strip().lower()
            for item in os.getenv("LILY_REQUIRED_COMPONENTS", "core,brain").split(",")
            if item.strip()
        }
        self.disabled_components: set[str] = {
            item.strip().lower().replace("-", "_")
            for item in os.getenv("LILY_DISABLED_COMPONENTS", "").split(",")
            if item.strip()
        }
        self.brain_provider = os.getenv("LILY_BRAIN_PROVIDER", "lmstudio").strip().lower()
        self.text_fallback_provider = os.getenv("LILY_TEXT_FALLBACK_PROVIDER", "openai_compat").strip().lower()
        self.vision_provider = os.getenv("LILY_VISION_PROVIDER", "claude").strip().lower()
        self.voice_provider = os.getenv("LILY_VOICE_PROVIDER", "sovits").strip().lower()
        if self.voice_provider not in self.VOICE_ROUTES:
            self.voice_provider = "sovits"
        self.text_provider_chain = self._parse_provider_chain(
            os.getenv("LILY_TEXT_PROVIDER_CHAIN", ""),
            [self.brain_provider, self.text_fallback_provider, "claude", "gemini"],
        )

        self.local_openai_base = os.getenv("OPENAI_API_BASE", "http://127.0.0.1:1234/v1").strip()
        self.local_openai_api_key = os.getenv("OPENAI_API_KEY", "lm-studio").strip()
        self.local_brain_model = os.getenv("LILY_LOCAL_BRAIN_MODEL", "loyal-macaroni-maid-7b").strip()
        self.local_router_model = os.getenv("LILY_LOCAL_ROUTER_MODEL", "qwen2.5-coder-0.5b-instruct").strip()

        self.openai_compat_base = os.getenv("LILY_OPENAI_COMPAT_BASE", "http://localhost:1430/v1").strip()
        self.openai_compat_api_key = os.getenv("LILY_OPENAI_COMPAT_API_KEY", "").strip()
        self.openai_compat_brain_model = os.getenv("LILY_OPENAI_COMPAT_BRAIN_MODEL", "gpt-5.4").strip()
        self.openai_compat_vision_model = os.getenv("LILY_OPENAI_COMPAT_VISION_MODEL", "gpt-5.4").strip()
        self.openai_compat_timeout_seconds = int(os.getenv("LILY_OPENAI_COMPAT_TIMEOUT_SECONDS", "45"))
        self.openai_compat_thinking_mode = os.getenv("LILY_OPENAI_COMPAT_THINKING_MODE", "").strip().lower()

        self.stream_stage_vision_provider = os.getenv("LILY_STREAM_STAGE_VISION_PROVIDER", "").strip().lower()
        self.stream_stage_vision_base = os.getenv(
            "LILY_STREAM_STAGE_VISION_BASE",
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        ).strip()
        self.stream_stage_vision_api_key = os.getenv("LILY_STREAM_STAGE_VISION_API_KEY", "").strip()
        self.stream_stage_vision_model = os.getenv("LILY_STREAM_STAGE_VISION_MODEL", "qwen3.5-flash").strip()
        self.stream_stage_vision_timeout_seconds = int(os.getenv("LILY_STREAM_STAGE_VISION_TIMEOUT_SECONDS", "45"))
        self.stream_stage_vision_fallback_enabled = self._parse_bool(
            os.getenv("LILY_STREAM_STAGE_VISION_FALLBACK_ENABLED", "true"),
            True,
        )
        self.stream_stage_vision_fallback_chain = self._parse_provider_chain(
            os.getenv("LILY_STREAM_STAGE_VISION_FALLBACK_CHAIN", ""),
            ["stream_stage_openai_compat", "claude"],
        )

        self.claude_api_key = os.getenv("CLAUDE_API_KEY", "").strip()
        self.claude_model = os.getenv("CLAUDE_MODEL", "claude-3-5-sonnet-latest").strip()
        self.claude_max_tokens = int(os.getenv("CLAUDE_MAX_TOKENS", "220"))
        self.claude_timeout_seconds = int(os.getenv("CLAUDE_TIMEOUT_SECONDS", "45"))

        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.gemini_model = os.getenv("GEMINI_MODEL", "gemini-2.0-flash").strip()
        self.gemini_max_requests_per_minute = int(os.getenv("GEMINI_MAX_REQUESTS_PER_MINUTE", "8"))
        self.intent_router_enabled = os.getenv("LILY_INTENT_ROUTER_ENABLED", "true").strip().lower() not in {
            "0",
            "false",
            "no",
            "off",
        }
        self.intent_router_timeout_seconds = float(os.getenv("LILY_INTENT_ROUTER_TIMEOUT_SECONDS", "2.0"))
        self.intent_router_min_confidence = float(os.getenv("LILY_INTENT_ROUTER_MIN_CONFIDENCE", "0.72"))

        self.home_vessel_url = os.getenv("LILY_HOME_VESSEL_URL", "http://127.0.0.1:10896").strip()
        self.home_vessel_token = os.getenv("LILY_HOME_VESSEL_TOKEN", "").strip()
        self.home_vessel_timeout_seconds = float(os.getenv("LILY_HOME_VESSEL_TIMEOUT_SECONDS", "4.0"))
        self.home_planner_enabled = self._parse_bool(os.getenv("LILY_HOME_PLANNER_ENABLED", "true"), True)
        self.home_planner_timeout_seconds = float(os.getenv("LILY_HOME_PLANNER_TIMEOUT_SECONDS", "12.0"))
        self.home_planner_min_confidence = float(os.getenv("LILY_HOME_PLANNER_MIN_CONFIDENCE", "0.75"))
        self.home_context_ttl_seconds = float(os.getenv("LILY_HOME_CONTEXT_TTL_SECONDS", "600.0"))

        self.voice_service_url = os.getenv("LILY_VOICE_SERVICE_URL", "").strip()
        self.voice_service_health_url = os.getenv("LILY_VOICE_SERVICE_HEALTH_URL", "").strip()
        self.voice_service_token = os.getenv("LILY_VOICE_SERVICE_TOKEN", "").strip()
        self.voice_service_timeout_seconds = int(os.getenv("LILY_VOICE_SERVICE_TIMEOUT_SECONDS", "180"))
        self.voice_service_health_timeout_seconds = float(
            os.getenv("LILY_VOICE_SERVICE_HEALTH_TIMEOUT_SECONDS", "0.5")
        )
        self.voice_service_registry = os.getenv("LILY_VOICE_SERVICE_REGISTRY", "")
        self.voice_nodes = parse_voice_nodes(
            os.getenv("LILY_VOICE_SERVICE_REGISTRY", ""),
            legacy_url=self.voice_service_url,
            legacy_health_url=self.voice_service_health_url,
            legacy_token=self.voice_service_token,
            default_timeout_seconds=float(self.voice_service_timeout_seconds),
        )
        self.voice_language = os.getenv("LILY_VOICE_LANGUAGE", "ja").strip().lower()
        self.voice_profile = os.getenv("LILY_VOICE_PROFILE", "").strip()
        self.tts_chunking_enabled = self._parse_bool(
            os.getenv("LILY_TTS_CHUNKING_ENABLED", "true"),
            True,
        )
        self.tts_chunk_max_chars = max(80, int(os.getenv("LILY_TTS_CHUNK_MAX_CHARS", "220")))
        self.tts_chunk_max_words = max(12, int(os.getenv("LILY_TTS_CHUNK_MAX_WORDS", "30")))
        self.tts_chunk_gap_ms = max(0, int(os.getenv("LILY_TTS_CHUNK_GAP_MS", "80")))

        self.alibaba_api_key = os.getenv("LILY_ALIBABA_API_KEY", "").strip()
        self.alibaba_api_url = os.getenv(
            "LILY_ALIBABA_API_URL",
            "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        ).strip()
        self.alibaba_model = os.getenv("LILY_ALIBABA_MODEL", "qwen-audio-3.0-tts-flash").strip()
        self.alibaba_timeout_seconds = float(os.getenv("LILY_ALIBABA_TIMEOUT_SECONDS", "90"))
        self.alibaba_voice_id = os.getenv("LILY_ALIBABA_VOICE_ID", "").strip()
        self.alibaba_voice_map = self._parse_json_string_map(os.getenv("LILY_ALIBABA_VOICE_MAP", ""))
        self.alibaba_indonesian_default = self._parse_bool(
            os.getenv("LILY_ALIBABA_INDONESIAN_DEFAULT", "false")
        )
        self.alibaba_workspace_id = os.getenv("LILY_ALIBABA_WORKSPACE_ID", "").strip()
        self.alibaba_region = os.getenv("LILY_ALIBABA_REGION", "ap-southeast-1").strip().lower()
        self.alibaba_instruction = os.getenv(
            "LILY_ALIBABA_INSTRUCTION",
            "Speak naturally and warmly, with clear diction, moderate conversational pacing, and restrained emotion.",
        ).strip()

        self.stream_voice_provider = os.getenv("LILY_STREAM_VOICE_PROVIDER", "edge_rvc").strip().lower()
        self.stream_stage_voice_route = os.getenv("LILY_STREAM_STAGE_VOICE_ROUTE", "stream_stage").strip().lower()
        if self.stream_stage_voice_route not in {*self.VOICE_ROUTES, "stream_stage", "stream_voice"}:
            self.stream_stage_voice_route = "stream_stage"
        self.stream_voice_tts_mode = os.getenv("LILY_STREAM_VOICE_TTS_MODE", "auto").strip().lower()
        if self.stream_voice_tts_mode not in {"auto", "google", "edge"}:
            self.stream_voice_tts_mode = "auto"
        self.stream_voice_service_url = os.getenv(
            "LILY_STREAM_VOICE_SERVICE_URL",
            "http://127.0.0.1:10897/api/voice/synthesize",
        ).strip()
        self.stream_voice_service_health_url = os.getenv(
            "LILY_STREAM_VOICE_SERVICE_HEALTH_URL",
            "http://127.0.0.1:10897/health",
        ).strip()
        self.stream_voice_service_token = os.getenv("LILY_STREAM_VOICE_SERVICE_TOKEN", "").strip()
        self.stream_voice_service_timeout_seconds = float(
            os.getenv("LILY_STREAM_VOICE_SERVICE_TIMEOUT_SECONDS", "90")
        )
        self.stream_voice_service_health_timeout_seconds = float(
            os.getenv("LILY_STREAM_VOICE_SERVICE_HEALTH_TIMEOUT_SECONDS", "1.0")
        )

        self.stt_service_url = os.getenv(
            "LILY_STT_SERVICE_URL",
            "http://127.0.0.1:10894/api/stt/transcribe",
        ).strip()
        self.stt_service_token = os.getenv("LILY_STT_SERVICE_TOKEN", "").strip()
        self.listener_nodes_json = os.getenv("LILY_LISTENER_NODES", "[]").strip() or "[]"
        self.stt_service_timeout_seconds = float(os.getenv("LILY_STT_SERVICE_TIMEOUT_SECONDS", "75"))
        self.stt_max_upload_bytes = int(os.getenv("LILY_STT_MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))

        self.finance_vessel_url = os.getenv("LILY_FINANCE_VESSEL_URL", "http://127.0.0.1:10895").strip()
        self.finance_vessel_token = os.getenv("LILY_FINANCE_VESSEL_TOKEN", "").strip()
        self.finance_vessel_timeout_seconds = float(os.getenv("LILY_FINANCE_VESSEL_TIMEOUT_SECONDS", "12"))
        self.finance_draft_ttl_seconds = int(os.getenv("LILY_FINANCE_DRAFT_TTL_SECONDS", "900"))
        self.finance_receipt_max_bytes = int(os.getenv("LILY_FINANCE_RECEIPT_MAX_BYTES", str(5 * 1024 * 1024)))

        core_root = Path(__file__).resolve().parent.parent
        self.state_db_path = os.getenv(
            "LILY_STATE_DB_PATH",
            str(core_root / "runtime" / "lily_state.sqlite3"),
        ).strip()
        self.chat_retention_days = int(os.getenv("LILY_CHAT_RETENTION_DAYS", "180"))
        self.live_event_retention_days = int(os.getenv("LILY_LIVE_EVENT_RETENTION_DAYS", "7"))
        self.owner_timezone = os.getenv("LILY_OWNER_TIMEZONE", "Asia/Jakarta").strip() or "Asia/Jakarta"
        self.core_host = os.getenv("LILY_CORE_HOST", "127.0.0.1").strip() or "127.0.0.1"
        self.core_port = int(os.getenv("LILY_CORE_PORT", "8000"))
        self.owner_api_token = os.getenv("LILY_OWNER_API_TOKEN", "").strip()
        environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
        secure_environment = environment not in {"development", "dev", "local"}
        self.owner_api_token_enforced = self._parse_bool(
            os.getenv("LILY_OWNER_API_TOKEN_ENFORCED", "true" if secure_environment else "false"),
            secure_environment,
        )
        self.public_base_url = os.getenv("LILY_PUBLIC_BASE_URL", "").strip().rstrip("/")
        self.public_service_map = os.getenv("LILY_PUBLIC_SERVICE_MAP", "").strip()
        self.hud_event_sources = {
            value.strip().lower()
            for value in os.getenv(
                "LILY_HUD_EVENT_SOURCES",
                "dashboard,mobile_realm,hotkey",
            ).split(",")
            if value.strip()
        }

        self.live_vision_cooldown_ms = int(os.getenv("LIVE_VISION_COOLDOWN_MS", "6000"))
        self.live_voice_cooldown_ms = int(os.getenv("LIVE_VOICE_COOLDOWN_MS", "8000"))
        self.wa_auto_reply_cooldown_ms = int(os.getenv("WA_AUTO_REPLY_COOLDOWN_MS", "30000"))
        self.max_session_events = int(os.getenv("LILY_MAX_SESSION_EVENTS", "50"))
        self.conversation_context_turns = max(
            1,
            min(int(os.getenv("LILY_CONVERSATION_CONTEXT_TURNS", "12")), 24),
        )
        self.conversation_context_summary_turns = max(
            0,
            min(int(os.getenv("LILY_CONVERSATION_CONTEXT_SUMMARY_TURNS", "4")), 12),
        )
        self.conversation_context_max_chars = max(
            4000,
            min(int(os.getenv("LILY_CONVERSATION_CONTEXT_MAX_CHARS", "16000")), 30000),
        )

        self.openclaw_enabled = self._parse_bool(os.getenv("LILY_OPENCLAW_ENABLED", "true"), True)
        self.tool_agent_mode = os.getenv("LILY_TOOL_AGENT_MODE", "local").strip().lower() or "local"
        self.tool_agent_provider = os.getenv("LILY_TOOL_AGENT_PROVIDER", "openclaw").strip().lower() or "openclaw"
        self.tool_agent_url = os.getenv("LILY_TOOL_AGENT_URL", "http://127.0.0.1:8092/api/tool/run").strip()
        self.tool_agent_health_url = os.getenv("LILY_TOOL_AGENT_HEALTH_URL", "http://127.0.0.1:8092/api/health").strip()
        self.tool_agent_token = os.getenv("LILY_TOOL_AGENT_TOKEN", "").strip()
        self.tool_agent_timeout_seconds = int(
            os.getenv(
                "LILY_TOOL_AGENT_TIMEOUT_SECONDS",
                os.getenv("LILY_OPENCLAW_TIMEOUT_SECONDS", "120"),
            )
        )
        self.tool_artifact_dir = os.getenv(
            "LILY_TOOL_ARTIFACT_DIR",
            str(Path(__file__).resolve().parent.parent / "static" / "tool_artifacts"),
        ).strip()
        self.tool_artifact_max_bytes = int(os.getenv("LILY_TOOL_ARTIFACT_MAX_BYTES", str(20 * 1024 * 1024)))
        self.tool_artifact_retention_days = max(1, int(os.getenv("LILY_TOOL_ARTIFACT_RETENTION_DAYS", "30")))
        self.tool_artifact_quota_bytes = max(
            self.tool_artifact_max_bytes,
            int(os.getenv("LILY_TOOL_ARTIFACT_QUOTA_BYTES", str(512 * 1024 * 1024))),
        )
        self.tool_artifact_allowed_extensions = self._parse_csv(
            os.getenv("LILY_TOOL_ARTIFACT_ALLOWED_EXTENSIONS", ""),
            ["png", "jpg", "jpeg", "webp", "gif", "pdf", "docx", "xlsx", "txt", "md", "zip"],
        )
        self.tool_artifact_allowed_extensions = [
            extension if extension.startswith(".") else f".{extension}"
            for extension in self.tool_artifact_allowed_extensions
        ]
        self.openclaw_gateway_url = os.getenv("LILY_OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789").strip()
        self.openclaw_cli = os.getenv("LILY_OPENCLAW_CLI", "openclaw").strip() or "openclaw"
        self.openclaw_timeout_seconds = int(os.getenv("LILY_OPENCLAW_TIMEOUT_SECONDS", "120"))
        self.openclaw_approval_expiry_seconds = max(
            60,
            int(os.getenv("LILY_OPENCLAW_APPROVAL_EXPIRY_SECONDS", "900")),
        )
        self.openclaw_intent_min_confidence = min(
            1.0,
            max(0.5, float(os.getenv("LILY_OPENCLAW_INTENT_MIN_CONFIDENCE", "0.80"))),
        )
        self.openclaw_allowed_sources = self._parse_csv(
            os.getenv("LILY_OPENCLAW_ALLOWED_SOURCES", ""),
            ["dashboard", "mobile_realm", "wa_bridge", "listener"],
        )
        self.openclaw_allowed_actions = self._parse_csv(
            os.getenv("LILY_OPENCLAW_ALLOWED_ACTIONS", ""),
            ["web_search", "browse", "research", "summarize", "status", "file_task", "automation"],
        )
        self.openclaw_approval_required_actions = self._parse_csv(
            os.getenv("LILY_OPENCLAW_APPROVAL_REQUIRED_ACTIONS", ""),
            ["file_task", "automation", "system", "command", "send_message", "delete", "dangerous"],
        )
        self.openclaw_auto_approve_readonly = self._parse_bool(
            os.getenv("LILY_OPENCLAW_AUTO_APPROVE_READONLY", "true"),
            True,
        )

        apply_runtime_overrides(self, self.runtime_overrides)
        if self.voice_provider not in self.VOICE_ROUTES:
            self.voice_provider = "sovits"
        if self.stream_voice_tts_mode not in {"auto", "google", "edge"}:
            self.stream_voice_tts_mode = "auto"
        self.disabled_components = {
            item for item in self.disabled_components if item in self.COMPONENT_IDS or item == "tools"
        }
        # URL overrides must also update the parsed multi-node voice registry.
        self.voice_nodes = parse_voice_nodes(
            self.voice_service_registry,
            legacy_url=self.voice_service_url,
            legacy_health_url=self.voice_service_health_url,
            legacy_token=self.voice_service_token,
            default_timeout_seconds=float(self.voice_service_timeout_seconds),
        )

    def reload_runtime_overrides(self) -> None:
        """Reload environment defaults plus the owner-managed local override file."""
        self.__init__()

    def is_component_disabled(self, component_id: str) -> bool:
        normalized = str(component_id or "").strip().lower().replace("-", "_")
        if normalized in {"core", "brain"}:
            return False
        if normalized == "openclaw":
            return "tools" in self.disabled_components or "openclaw" in self.disabled_components
        return normalized in self.disabled_components

    def is_component_enabled(self, component_id: str) -> bool:
        return not self.is_component_disabled(component_id)

    def is_component_required(self, component_id: str) -> bool:
        normalized = str(component_id or "").strip().lower().replace("-", "_")
        if normalized == "openclaw" and "tools" in self.required_components:
            return True
        return normalized in self.required_components

    @staticmethod
    def _parse_json_string_map(raw_value: str) -> dict[str, str]:
        if not raw_value.strip():
            return {}
        try:
            decoded = json.loads(raw_value)
        except json.JSONDecodeError:
            return {}
        if not isinstance(decoded, dict):
            return {}
        return {
            str(key).strip().lower(): str(value).strip()
            for key, value in decoded.items()
            if str(key).strip() and str(value).strip()
        }

    def resolve_alibaba_voice_id(self, voice_profile: str | None = None) -> str:
        profile_key = str(voice_profile or "").strip().lower()
        return self.alibaba_voice_map.get(profile_key) or self.alibaba_voice_id


settings = LilyCoreSettings()
