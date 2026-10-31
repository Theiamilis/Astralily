import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - setup scripts install python-dotenv for runtime.
    def load_dotenv(*_args, **_kwargs):
        return False


BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


class SttVesselSettings:
    @staticmethod
    def _parse_bool(raw_value: str, fallback: bool = False) -> bool:
        if raw_value.strip() == "":
            return fallback
        return raw_value.strip().lower() in {"1", "true", "yes", "on", "enabled"}

    @staticmethod
    def _parse_int(raw_value: str, fallback: int) -> int:
        try:
            return int(raw_value.strip())
        except (TypeError, ValueError):
            return fallback

    @staticmethod
    def _parse_float(raw_value: str, fallback: float) -> float:
        try:
            return float(raw_value.strip())
        except (TypeError, ValueError):
            return fallback

    @staticmethod
    def _parse_provider_chain(raw_value: str) -> tuple[str, ...]:
        supported = {"groq", "local"}
        providers: list[str] = []
        for raw_provider in raw_value.split(","):
            provider = raw_provider.strip().lower()
            if provider in supported and provider not in providers:
                providers.append(provider)
        return tuple(providers or ("local",))

    def __init__(self) -> None:
        self.host = os.getenv("LILY_STT_VESSEL_HOST", "127.0.0.1").strip() or "127.0.0.1"
        self.port = self._parse_int(os.getenv("LILY_STT_VESSEL_PORT", "10894"), 10894)
        self.token = os.getenv("LILY_STT_VESSEL_TOKEN", "").strip()
        self.cors_allow_origins = os.getenv(
            "LILY_STT_CORS_ALLOW_ORIGINS",
            os.getenv("LILY_CORS_ALLOW_ORIGINS", "*"),
        ).strip()
        self.provider_chain = self._parse_provider_chain(
            os.getenv("LILY_STT_PROVIDER_CHAIN", "groq,local")
        )
        self.groq_api_key = os.getenv(
            "LILY_STT_GROQ_API_KEY",
            os.getenv("GROQ_API_KEY", ""),
        ).strip()
        self.groq_base_url = os.getenv(
            "LILY_STT_GROQ_BASE_URL",
            "https://api.groq.com/openai/v1",
        ).strip().rstrip("/")
        self.groq_model = os.getenv(
            "LILY_STT_GROQ_MODEL",
            "whisper-large-v3-turbo",
        ).strip() or "whisper-large-v3-turbo"
        self.groq_timeout_seconds = max(
            5.0,
            self._parse_float(os.getenv("LILY_STT_GROQ_TIMEOUT_SECONDS", "30"), 30.0),
        )
        self.model = os.getenv("LILY_STT_MODEL", "base").strip() or "base"
        self.device = os.getenv("LILY_STT_DEVICE", "cpu").strip() or "cpu"
        self.compute_type = os.getenv("LILY_STT_COMPUTE_TYPE", "int8").strip() or "int8"
        self.language = os.getenv("LILY_STT_LANGUAGE", "").strip().lower()
        self.download_root = os.getenv("LILY_STT_DOWNLOAD_ROOT", "").strip()
        self.max_upload_bytes = self._parse_int(
            os.getenv("LILY_STT_MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)),
            10 * 1024 * 1024,
        )
        self.max_audio_seconds = self._parse_float(os.getenv("LILY_STT_MAX_AUDIO_SECONDS", "45"), 45.0)
        self.beam_size = self._parse_int(os.getenv("LILY_STT_BEAM_SIZE", "1"), 1)
        self.cpu_threads = self._parse_int(os.getenv("LILY_STT_CPU_THREADS", "0"), 0)
        self.num_workers = self._parse_int(os.getenv("LILY_STT_NUM_WORKERS", "1"), 1)
        self.vad_filter = self._parse_bool(os.getenv("LILY_STT_VAD_FILTER", "true"), True)
        self.load_on_startup = self._parse_bool(os.getenv("LILY_STT_LOAD_ON_STARTUP", "false"), False)


settings = SttVesselSettings()
