import os
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    def load_dotenv(*_args, **_kwargs):
        return False


BASE_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BASE_DIR.parent
load_dotenv(BASE_DIR / ".env")


def _as_int(name: str, fallback: int) -> int:
    try:
        return int(os.getenv(name, str(fallback)).strip())
    except ValueError:
        return fallback


class ModelVesselSettings:
    def __init__(self) -> None:
        self.host = os.getenv("LILY_MODEL_VESSEL_HOST", "127.0.0.1").strip() or "127.0.0.1"
        self.port = _as_int("LILY_MODEL_VESSEL_PORT", 10898)
        self.token = os.getenv("LILY_MODEL_VESSEL_TOKEN", "").strip()
        self.cors_allow_origins = os.getenv(
            "LILY_MODEL_CORS_ALLOW_ORIGINS",
            os.getenv("LILY_CORS_ALLOW_ORIGINS", "*"),
        ).strip()
        self.asset_root = Path(
            os.getenv("LILY_MODEL_ASSET_ROOT", str(REPO_DIR / "local_assets" / "live2d_models"))
        ).expanduser().resolve()
        self.database_path = Path(
            os.getenv("LILY_MODEL_DATABASE_PATH", str(BASE_DIR / "runtime" / "model_registry.sqlite3"))
        ).expanduser().resolve()
        self.public_base_url = os.getenv("LILY_MODEL_PUBLIC_BASE_URL", "").strip().rstrip("/")
        self.max_upload_bytes = _as_int("LILY_MODEL_MAX_UPLOAD_BYTES", 256 * 1024 * 1024)
        self.max_unpacked_bytes = _as_int("LILY_MODEL_MAX_UNPACKED_BYTES", 768 * 1024 * 1024)
        self.max_archive_files = _as_int("LILY_MODEL_MAX_ARCHIVE_FILES", 4096)


settings = ModelVesselSettings()

