import importlib.util
import logging
import math
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from .providers import GroqSttClient, SttProviderError, upload_filename
from .network_security import require_token_for_non_loopback
from .schemas import HealthResponse, SttSegment, TranscriptionResponse
from .settings import settings


logging.basicConfig(level=logging.INFO, format="[Lily STT Vessel] %(message)s")
logger = logging.getLogger("lily_stt_vessel")

_model_lock = Lock()
_model = None
_model_error = ""
_groq_client = GroqSttClient(
    api_key=settings.groq_api_key,
    base_url=settings.groq_base_url,
    model=settings.groq_model,
    timeout_seconds=settings.groq_timeout_seconds,
)


def normalize_language_hint(language: str | None) -> str:
    """Return a provider-compatible language hint, or empty for autodetect."""
    normalized = (language or "").strip().lower()
    if normalized in {"auto", "automatic", "detect", "autodetect"}:
        return ""
    return normalized


def _cors_allow_origins() -> list[str]:
    raw_origins = settings.cors_allow_origins
    environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
    development = environment in {"development", "dev", "local"}
    if not raw_origins:
        return ["*"] if development else []
    if raw_origins == "*":
        return ["*"] if development else []
    return [origin.strip().rstrip("/") for origin in raw_origins.split(",") if origin.strip()]


def _fLily-Voice-Host_whisper_available() -> bool:
    return importlib.util.find_spec("fLily-Voice-Host_whisper") is not None


def _require_token(
    authorization: str | None = Header(default=None),
    x_lily_stt_token: str | None = Header(default=None),
) -> None:
    if not settings.token:
        environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
        if environment not in {"development", "dev", "local"}:
            raise HTTPException(status_code=503, detail="STT Vessel service token is not configured.")
        return
    bearer = ""
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization.split(" ", 1)[1].strip()
    if x_lily_stt_token == settings.token or bearer == settings.token:
        return
    raise HTTPException(status_code=401, detail="Missing or invalid STT Vessel token.")


def _load_model():
    global _model, _model_error

    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model

        try:
            from fLily-Voice-Host_whisper import WhisperModel

            kwargs = {"num_workers": max(1, settings.num_workers)}
            if settings.cpu_threads > 0:
                kwargs["cpu_threads"] = settings.cpu_threads
            if settings.download_root:
                kwargs["download_root"] = settings.download_root

            logger.info(
                "Loading fLily-Voice-Host-whisper model=%s device=%s compute_type=%s",
                settings.model,
                settings.device,
                settings.compute_type,
            )
            _model = WhisperModel(
                settings.model,
                device=settings.device,
                compute_type=settings.compute_type,
                **kwargs,
            )
            _model_error = ""
            return _model
        except Exception as error:
            _model_error = str(error)
            logger.exception("Could not load STT model.")
            raise HTTPException(status_code=503, detail=f"STT model is not ready: {_model_error}") from error


def _probe_audio_duration_seconds(path: Path) -> float | None:
    try:
        import av

        with av.open(str(path)) as container:
            if container.duration:
                return float(container.duration / av.time_base)
            for stream in container.streams.audio:
                if stream.duration and stream.time_base:
                    return float(stream.duration * stream.time_base)
    except Exception:
        return None
    return None


def _safe_upload_suffix(filename: str | None, content_type: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix and len(suffix) <= 12:
        return suffix

    mime_type = (content_type or "").lower()
    if "ogg" in mime_type or "opus" in mime_type:
        return ".ogg"
    if "mpeg" in mime_type or "mp3" in mime_type:
        return ".mp3"
    if "wav" in mime_type:
        return ".wav"
    if "mp4" in mime_type or "m4a" in mime_type:
        return ".m4a"
    return ".audio"


async def _save_upload_to_temp(file: UploadFile) -> tuple[Path, int]:
    suffix = _safe_upload_suffix(file.filename, file.content_type)
    temp = tempfile.NamedTemporaryFile(prefix="lily_stt_", suffix=suffix, delete=False)
    path = Path(temp.name)
    total_bytes = 0
    try:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            total_bytes += len(chunk)
            if total_bytes > settings.max_upload_bytes:
                temp.close()
                path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=f"Audio upload is too large. Limit is {settings.max_upload_bytes} bytes.",
                )
            temp.write(chunk)
    finally:
        temp.close()

    if total_bytes <= 0:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Audio upload is empty.")

    return path, total_bytes


def _transcribe_local_path(path: Path, language: str = "") -> TranscriptionResponse:
    model = _load_model()
    selected_language = normalize_language_hint(language or settings.language) or None
    kwargs = {
        "beam_size": max(1, settings.beam_size),
        "vad_filter": settings.vad_filter,
    }
    if selected_language:
        kwargs["language"] = selected_language

    segments, info = model.transcribe(str(path), **kwargs)
    segment_payloads = [
        SttSegment(
            start=float(segment.start),
            end=float(segment.end),
            text=segment.text.strip(),
            avg_logprob=float(getattr(segment, "avg_logprob", 0.0) or 0.0),
            no_speech_probability=max(
                0.0,
                min(1.0, float(getattr(segment, "no_speech_prob", 0.0) or 0.0)),
            ),
        )
        for segment in segments
        if segment.text and segment.text.strip()
    ]
    text = " ".join(segment.text for segment in segment_payloads).strip()
    weights = [max(0.01, segment.end - segment.start) for segment in segment_payloads]
    total_weight = sum(weights)
    avg_logprob = (
        sum(segment.avg_logprob * weight for segment, weight in zip(segment_payloads, weights)) / total_weight
        if total_weight
        else -10.0
    )
    no_speech_probability = (
        sum(segment.no_speech_probability * weight for segment, weight in zip(segment_payloads, weights))
        / total_weight
        if total_weight
        else 1.0
    )
    return TranscriptionResponse(
        text=text,
        language=str(getattr(info, "language", "") or selected_language or ""),
        duration_seconds=float(getattr(info, "duration", 0.0) or 0.0),
        model=settings.model,
        provider="local",
        confidence=max(0.0, min(1.0, math.exp(avg_logprob))) if text else 0.0,
        no_speech_probability=max(0.0, min(1.0, no_speech_probability)),
        language_probability=max(
            0.0,
            min(1.0, float(getattr(info, "language_probability", 0.0) or 0.0)),
        ),
        segments=segment_payloads,
    )


async def _transcribe_with_providers(
    path: Path,
    language: str = "",
    duration_hint: float | None = None,
    local_only: bool = False,
) -> TranscriptionResponse:
    failures: list[str] = []
    audio: bytes | None = None
    selected_language = normalize_language_hint(language or settings.language)

    for provider in (("local",) if local_only else settings.provider_chain):
        try:
            if provider == "groq":
                if not _groq_client.configured:
                    failures.append("groq: not configured")
                    continue
                if audio is None:
                    audio = await run_in_threadpool(path.read_bytes)
                result = await _groq_client.transcribe(
                    audio,
                    filename=upload_filename(path),
                    language=selected_language,
                    duration_hint=duration_hint,
                )
            elif provider == "local":
                result = await run_in_threadpool(_transcribe_local_path, path, selected_language)
            else:  # Settings filters unsupported providers; keep this defensive for runtime edits.
                continue

            logger.info(
                "Transcription completed provider=%s model=%s duration=%.2fs",
                result.provider,
                result.model,
                result.duration_seconds,
            )
            return result
        except SttProviderError as error:
            failures.append(f"{provider}: {error}")
            logger.warning("STT provider %s failed; trying fallback: %s", provider, error)
        except HTTPException as error:
            failures.append(f"{provider}: {error.detail}")
            logger.warning("STT provider %s failed; trying fallback: %s", provider, error.detail)
        except Exception as error:
            failures.append(f"{provider}: unavailable")
            logger.exception("STT provider %s failed unexpectedly; trying fallback.", provider)

    detail = "; ".join(failures) or "no providers are enabled"
    raise HTTPException(status_code=503, detail=f"STT providers are unavailable: {detail}.")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    require_token_for_non_loopback(settings.host, settings.token, "STT Vessel")
    if settings.load_on_startup and "local" in settings.provider_chain:
        try:
            await run_in_threadpool(_load_model)
        except HTTPException:
            logger.warning("Startup model load failed; health will report degraded until fixed.")
    yield


app = FastAPI(title="Lily STT Vessel", version="0.2.0", lifespan=lifespan)

# Report the build actually loaded by this service, independently of later file updates.
import runpy as _runtime_runpy
from pathlib import Path as _RuntimePath
_runtime_runpy.run_path(str(_RuntimePath(__file__).resolve().parents[2] / "scripts" / "runtime_status.py"))["install_tracking"](app, "stt_vessel")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/auth/check")
def credential_check(x_lily_token: str | None = Header(default=None)) -> dict:
    """Cheap authenticated probe for credential rotation; never runs a model."""
    import hmac
    if not settings.token or not hmac.compare_digest(x_lily_token or "", settings.token):
        raise HTTPException(status_code=401, detail="Invalid service credential")
    return {"authenticated": True, "service": "stt"}


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    available = (
        ("groq" in settings.provider_chain and _groq_client.configured)
        or ("local" in settings.provider_chain and _fLily-Voice-Host_whisper_available() and not _model_error)
    )
    return HealthResponse(
        status="ok" if available else "degraded",
        service="lily_stt_vessel",
        detail="STT Vessel is ready." if available else "No STT provider is ready.",
    )


@app.get("/api/stt/health")
def detailed_health(_auth: None = Depends(_require_token)) -> dict:
    available_providers: list[str] = []
    if "groq" in settings.provider_chain and _groq_client.configured:
        available_providers.append("groq")
    if "local" in settings.provider_chain and _fLily-Voice-Host_whisper_available() and not _model_error:
        available_providers.append("local")

    primary_provider = next(
        (provider for provider in settings.provider_chain if provider in available_providers),
        "",
    )
    if primary_provider == "groq":
        model = settings.groq_model
        device = "cloud"
        compute_type = "managed"
    else:
        model = settings.model
        device = settings.device
        compute_type = settings.compute_type

    if not available_providers:
        detail = "No STT providers are ready. Configure Groq or install fLily-Voice-Host-whisper."
    elif primary_provider == "groq":
        detail = "STT Vessel is ready. Groq is primary and local Whisper is the fallback."
    elif "groq" in settings.provider_chain and not _groq_client.configured:
        detail = "STT Vessel is ready with local Whisper. Groq is not configured."
    elif _model is not None:
        detail = "STT Vessel is ready with local Whisper."
    else:
        detail = "STT Vessel is ready. The local model loads on first transcription."

    return {
        "status": "ok" if available_providers else "degraded",
        "service": "lily_stt_vessel",
        "detail": detail,
        "model": model,
        "device": device,
        "compute_type": compute_type,
        "model_loaded": _model is not None,
        "provider_chain": list(settings.provider_chain),
        "cloud_configured": _groq_client.configured,
    }


@app.post("/api/stt/transcribe", response_model=TranscriptionResponse)
async def transcribe_audio(
    file: UploadFile = File(...),
    language: str = Form(default=""),
    local_only: bool = False,
    _auth: None = Depends(_require_token),
) -> TranscriptionResponse:
    path: Path | None = None
    try:
        path, _total_bytes = await _save_upload_to_temp(file)
        duration = await run_in_threadpool(_probe_audio_duration_seconds, path)
        if duration and duration > settings.max_audio_seconds:
            raise HTTPException(
                status_code=413,
                detail=f"Audio is too long. Limit is {settings.max_audio_seconds:.0f} seconds.",
            )
        result = await _transcribe_with_providers(path, language, duration, local_only=local_only)
        if duration and not result.duration_seconds:
            result.duration_seconds = duration
        return result
    finally:
        if path:
            path.unlink(missing_ok=True)


@app.post("/api/stt/transcribe/local", response_model=TranscriptionResponse)
async def transcribe_audio_local(
    file: UploadFile = File(...),
    language: str = Form(default=""),
    _auth: None = Depends(_require_token),
) -> TranscriptionResponse:
    return await transcribe_audio(file, language, local_only=True, _auth=_auth)
