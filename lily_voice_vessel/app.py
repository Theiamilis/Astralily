import hashlib
import hmac
import io
import logging
import math
import os
import re
import secrets
import subprocess
import sys
import tempfile
import time
import wave
from array import array
from ipaddress import ip_address
from pathlib import Path
from threading import Lock
from typing import Any

import requests
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

HOST = os.getenv("LILY_VOICE_VESSEL_HOST", "127.0.0.1")
PORT = int(os.getenv("LILY_VOICE_VESSEL_PORT", "10881"))
TOKEN = os.getenv("LILY_VOICE_VESSEL_TOKEN", "").strip()
AUDIO_URL_SIGNING_SECRET = (
    os.getenv("LILY_VOICE_AUDIO_URL_SIGNING_SECRET", "").strip()
    or TOKEN
    or secrets.token_urlsafe(32)
).encode("utf-8")
AUDIO_URL_TTL_SECONDS = max(30, int(os.getenv("LILY_VOICE_AUDIO_URL_TTL_SECONDS", "900")))
CACHE_MAX_FILES = max(8, int(os.getenv("LILY_VOICE_CACHE_MAX_FILES", "256")))
DEFAULT_SOVITS_URL = os.getenv("GPTSOVITS_API_URL", "http://127.0.0.1:10880").rstrip("/")
HEALTH_PROFILES = os.getenv("LILY_VOICE_HEALTH_PROFILES", "ja,en").strip()

AUDIO_DIR = BASE_DIR / "static" / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="[Lily Voice Vessel] %(message)s")
logger = logging.getLogger("lily_voice_vessel")

PROFILE_ENV_PREFIX = "LILY_VOICE_PROFILE_"
PROFILE_ENV_SUFFIXES = (
    "_API_URL",
    "_GPT_MODEL_PATH",
    "_SOVITS_MODEL_PATH",
    "_REF_AUDIO",
    "_REF_TEXT",
    "_REF_TEXT_PATH",
    "_TEXT_LANGUAGE",
    "_PROMPT_LANGUAGE",
    "_GAIN_DB",
    "_PITCH_SEMITONES",
)

SYNTHESIS_CACHE_VERSION = "clause-batch-v4"
SENTENCE_PAUSE_MS = 120
SYNTHESIS_CLAUSE_MAX_CHARS = max(40, int(os.getenv("LILY_VOICE_CLAUSE_MAX_CHARS", "40")))


def _normalize_voice_language(value: str | None) -> str:
    selected = (value or "").strip().lower()
    if selected.startswith("en"):
        return "en"
    return "ja"


def _normalize_voice_profile(value: str | None) -> str:
    selected = (value or "").strip().lower()
    if not selected:
        return ""
    if selected in {"id", "indonesian", "jp", "japanese"}:
        return "ja"
    return selected


DEFAULT_PROFILE = _normalize_voice_profile(os.getenv("LILY_VOICE_DEFAULT_PROFILE", "ja")) or "ja"


def _cors_allow_origins() -> list[str]:
    raw_origins = os.getenv("LILY_VOICE_CORS_ALLOW_ORIGINS", os.getenv("LILY_CORS_ALLOW_ORIGINS", "")).strip()
    environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
    development = environment in {"development", "dev", "local"}
    if not raw_origins:
        return ["*"] if development else []
    if raw_origins == "*":
        return ["*"] if development else []
    return [origin.strip().rstrip("/") for origin in raw_origins.split(",") if origin.strip()]


def _validate_network_security() -> None:
    normalized = HOST.strip().lower().strip("[]")
    try:
        loopback = normalized == "localhost" or ip_address(normalized).is_loopback
    except ValueError:
        loopback = normalized == "localhost"
    if not loopback and not TOKEN:
        raise RuntimeError(
            f"Voice Vessel refuses to bind to {HOST!r} without LILY_VOICE_VESSEL_TOKEN."
        )


app = FastAPI(title="Lily Voice Vessel", version="0.1.0")

# Report the build actually loaded by this service, independently of later file updates.
import runpy as _runtime_runpy
from pathlib import Path as _RuntimePath
_runtime_runpy.run_path(str(_RuntimePath(__file__).resolve().parents[1] / "scripts" / "runtime_status.py"))["install_tracking"](app, "voice_vessel")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.on_event("startup")
def validate_network_security() -> None:
    _validate_network_security()


def _audio_signature(filename: str, expires: int) -> str:
    return hmac.new(
        AUDIO_URL_SIGNING_SECRET,
        f"{filename}:{expires}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _verify_audio_access(filename: str, expires: str | None, signature: str | None) -> str:
    if not filename or filename != Path(filename).name or filename.startswith("."):
        return "invalid"
    try:
        expiry = int(str(expires or ""))
    except ValueError:
        return "invalid"
    now = int(time.time())
    if expiry < now:
        return "expired"
    if expiry > now + max(AUDIO_URL_TTL_SECONDS * 2, 3600):
        return "invalid"
    expected = _audio_signature(filename, expiry)
    return "ok" if signature and hmac.compare_digest(str(signature), expected) else "invalid"


@app.middleware("http")
async def protect_generated_audio(request: Request, call_next):
    path = request.url.path
    if path.startswith("/static/audio/"):
        access = _verify_audio_access(
            path.removeprefix("/static/audio/"),
            request.query_params.get("expires"),
            request.query_params.get("signature"),
        )
        if access == "expired":
            return JSONResponse(status_code=410, content={"detail": "Audio URL has expired."})
        if access != "ok":
            return JSONResponse(status_code=401, content={"detail": "Invalid audio URL."})
    response = await call_next(request)
    if path.startswith("/static/audio/"):
        response.headers["Cache-Control"] = "private, no-store"
    return response

_model_switch_lock = Lock()
_active_model_by_api_url: dict[str, tuple[str, str]] = {}
_synthesis_lock = Lock()
_queue_state_lock = Lock()
_queue_state: dict[str, Any] = {
    "waiting": 0,
    "active": False,
    "last_error": "",
    "last_audio_url": "",
}


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1)
    emotion: str = "normal"
    style: str = "normal"
    voice_language: str = "ja"
    voice_profile: str | None = None


def _profile_env_key(profile_id: str) -> str:
    return "".join(char if char.isalnum() else "_" for char in profile_id.upper())


def _discover_profile_ids() -> list[str]:
    discovered: list[str] = []

    def _append(profile_id: str) -> None:
        normalized = profile_id.strip().lower()
        if normalized and normalized not in discovered:
            discovered.append(normalized)

    for key in sorted(os.environ):
        if not key.startswith(PROFILE_ENV_PREFIX):
            continue
        for suffix in PROFILE_ENV_SUFFIXES:
            if not key.endswith(suffix):
                continue
            profile_key = key[len(PROFILE_ENV_PREFIX):-len(suffix)]
            if profile_key:
                _append(profile_key.lower())
            break

    for alias_key in ("LILY_VOICE_PROFILE_JA", "LILY_VOICE_PROFILE_ID", "LILY_VOICE_PROFILE_EN"):
        _append(os.getenv(alias_key, ""))

    if not discovered:
        return [DEFAULT_PROFILE]
    return discovered


def _health_profile_ids() -> list[str]:
    selected: list[str] = []
    if HEALTH_PROFILES:
        for item in [part.strip().lower() for part in HEALTH_PROFILES.split(",") if part.strip()]:
            if item not in selected:
                selected.append(item)

    for profile_id in _discover_profile_ids():
        if profile_id not in selected:
            selected.append(profile_id)

    if DEFAULT_PROFILE in selected:
        selected.remove(DEFAULT_PROFILE)
    selected.insert(0, DEFAULT_PROFILE)
    return selected


def _emotion_env_keys(emotion: str | None) -> list[str]:
    raw_emotion = (emotion or "").strip().lower()
    if not raw_emotion:
        return []

    candidates: list[str] = []

    def _append(value: str) -> None:
        key = _profile_env_key(value)
        if key and key not in candidates:
            candidates.append(key)

    _append(raw_emotion)

    aliases = {
        "normal": "NEUTRAL",
        "calm": "NEUTRAL",
        "joy": "HAPPY",
        "cheer": "HAPPY",
        "cheerful": "HAPPY",
        "love": "HAPPY",
        "soft": "HAPPY",
        "sweet": "HAPPY",
        "cute": "HAPPY",
        "gloomy": "SAD",
        "cry": "SAD",
        "crying": "SAD",
        "teary": "SAD",
        "warning": "ANGRY",
        "annoyed": "ANGRY",
        "serious": "ANGRY",
    }
    alias = aliases.get(raw_emotion)
    if alias:
        _append(alias)

    return candidates


def _resolve_path(raw_path: str) -> str:
    if not raw_path:
        return ""
    path = Path(raw_path)
    if path.is_absolute():
        return str(path)
    return str((BASE_DIR / path).resolve())


def _read_text_file(raw_path: str) -> str:
    path = _resolve_path(raw_path)
    if not path or not os.path.exists(path):
        return ""
    return Path(path).read_text(encoding="utf-8").strip()


def _apply_emotion_overrides(
    profile_key: str,
    emotion: str,
    audio_path: str,
    text_content: str,
    text_language: str,
    prompt_language: str,
) -> tuple[str, str, str, str]:
    for emotion_key in _emotion_env_keys(emotion):
        prefix = f"LILY_VOICE_PROFILE_{profile_key}_EMOTION_{emotion_key}"
        raw_audio = os.getenv(f"{prefix}_REF_AUDIO", "").strip()
        raw_text = os.getenv(f"{prefix}_REF_TEXT", "").strip()
        raw_text_path = os.getenv(f"{prefix}_REF_TEXT_PATH", "").strip()
        raw_text_language = os.getenv(f"{prefix}_TEXT_LANGUAGE", "").strip().lower()
        raw_prompt_language = os.getenv(f"{prefix}_PROMPT_LANGUAGE", "").strip().lower()

        has_override = any(
            [
                raw_audio,
                raw_text,
                raw_text_path,
                raw_text_language,
                raw_prompt_language,
            ]
        )
        if not has_override:
            continue

        resolved_audio = _resolve_path(raw_audio) if raw_audio else audio_path
        resolved_text = text_content
        if raw_text_path:
            resolved_text = _read_text_file(raw_text_path) or raw_text or text_content
        elif raw_text:
            resolved_text = raw_text

        return (
            resolved_audio,
            resolved_text,
            raw_text_language or text_language,
            raw_prompt_language or prompt_language,
        )

    return audio_path, text_content, text_language, prompt_language


def _profile_from_request(payload: SynthesizeRequest) -> dict[str, str]:
    language = _normalize_voice_language(payload.voice_language or DEFAULT_PROFILE)
    requested_profile = _normalize_voice_profile(payload.voice_profile)
    profile = (
        requested_profile
        or _normalize_voice_profile(os.getenv(f"LILY_VOICE_PROFILE_{language.upper()}", ""))
        or language
        or DEFAULT_PROFILE
    )
    key = _profile_env_key(profile)

    ref_text = os.getenv(f"LILY_VOICE_PROFILE_{key}_REF_TEXT", "").strip()
    ref_text_path = os.getenv(f"LILY_VOICE_PROFILE_{key}_REF_TEXT_PATH", "").strip()
    if not ref_text and ref_text_path:
        ref_text = _read_text_file(ref_text_path)

    audio = _resolve_path(
        os.getenv(f"LILY_VOICE_PROFILE_{key}_REF_AUDIO", f"static/ref_voice_{profile}.wav").strip()
    )
    text_language = os.getenv(f"LILY_VOICE_PROFILE_{key}_TEXT_LANGUAGE", language).strip() or language
    prompt_language = os.getenv(f"LILY_VOICE_PROFILE_{key}_PROMPT_LANGUAGE", language).strip() or language
    audio, ref_text, text_language, prompt_language = _apply_emotion_overrides(
        key,
        payload.emotion,
        audio,
        ref_text,
        text_language,
        prompt_language,
    )

    return {
        "profile": profile,
        "language": language,
        "api_url": os.getenv(f"LILY_VOICE_PROFILE_{key}_API_URL", DEFAULT_SOVITS_URL).rstrip("/"),
        "gpt_model_path": os.getenv(f"LILY_VOICE_PROFILE_{key}_GPT_MODEL_PATH", "").strip(),
        "sovits_model_path": os.getenv(f"LILY_VOICE_PROFILE_{key}_SOVITS_MODEL_PATH", "").strip(),
        "audio": audio,
        "text": ref_text,
        "text_language": text_language,
        "prompt_language": prompt_language,
        "gain_db": os.getenv(f"LILY_VOICE_PROFILE_{key}_GAIN_DB", "0").strip() or "0",
        "pitch_semitones": os.getenv(f"LILY_VOICE_PROFILE_{key}_PITCH_SEMITONES", "0").strip() or "0",
    }


def _queue_snapshot() -> dict[str, Any]:
    with _queue_state_lock:
        return dict(_queue_state)


def _queue_enter() -> None:
    with _queue_state_lock:
        _queue_state["waiting"] += 1
    _synthesis_lock.acquire()
    with _queue_state_lock:
        _queue_state["waiting"] = max(0, int(_queue_state["waiting"]) - 1)
        _queue_state["active"] = True


def _queue_exit(error: str = "", audio_url: str = "") -> None:
    with _queue_state_lock:
        _queue_state["active"] = False
        _queue_state["last_error"] = error
        if audio_url:
            _queue_state["last_audio_url"] = audio_url
    _synthesis_lock.release()


def _require_token(x_lily_token: str | None) -> None:
    if not TOKEN:
        environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
        if environment not in {"development", "dev", "local"}:
            raise HTTPException(status_code=503, detail="Voice Vessel service token is not configured.")
        return
    if x_lily_token != TOKEN:
        raise HTTPException(status_code=401, detail="Invalid Lily voice vessel token.")


def _ensure_gptsovits_model(profile: dict[str, str], *, force: bool = False) -> None:
    gpt_model_path = profile["gpt_model_path"]
    sovits_model_path = profile["sovits_model_path"]

    if not gpt_model_path and not sovits_model_path:
        return
    if not gpt_model_path or not sovits_model_path:
        raise HTTPException(
            status_code=503,
            detail="Voice profile checkpoint config is incomplete. Set both GPT and SoVITS paths, or leave both empty.",
        )

    api_url = profile["api_url"]
    desired_model = (gpt_model_path, sovits_model_path)

    with _model_switch_lock:
        if not force and _active_model_by_api_url.get(api_url) == desired_model:
            return

        response = requests.post(
            f"{api_url}/set_model",
            json={
                "gpt_model_path": gpt_model_path,
                "sovits_model_path": sovits_model_path,
            },
            timeout=180,
        )
        response.raise_for_status()
        data = response.json()
        if data.get("code") != 0:
            raise HTTPException(status_code=503, detail=f"GPT-SoVITS rejected model switch: {data}")

        _active_model_by_api_url[api_url] = desired_model


def _cache_name(text: str, profile: dict[str, str], mode: str) -> str:
    cache_input = "|".join(
        [
            text,
            profile["profile"],
            profile["language"],
            profile["api_url"],
            profile["gpt_model_path"],
            profile["sovits_model_path"],
            profile["audio"],
            profile["text"],
            profile["text_language"],
            profile["prompt_language"],
            profile["gain_db"],
            profile["pitch_semitones"],
            mode,
        ]
    )
    return f"cached_{hashlib.md5(cache_input.encode('utf-8')).hexdigest()}.wav"


def _speech_ready_clause(text: str) -> str:
    clause = str(text or "").strip().strip("—–- ")
    if not clause:
        return ""
    clause = re.sub(r"[,，、;；:：]\s*$", ".", clause)
    if clause[-1] not in ".!?~。！？":
        clause = f"{clause}."
    return clause


def _split_oversized_clause(text: str, max_chars: int) -> list[str]:
    comma_parts = [
        part.strip()
        for part in re.findall(r"[^,，、]+(?:[,，、]|$)", text)
        if part.strip()
    ]
    if len(comma_parts) <= 1:
        return [text]

    chunks: list[str] = []
    current = ""
    for part in comma_parts:
        candidate = f"{current} {part}".strip() if current else part
        if current and len(candidate) > max_chars:
            chunks.append(current)
            current = part
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def _split_synthesis_text(text: str, max_chars: int = SYNTHESIS_CLAUSE_MAX_CHARS) -> list[str]:
    normalized = " ".join(str(text or "").split()).strip()
    if not normalized:
        return []

    sentences = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?~。！？])\s+", normalized)
        if sentence.strip()
    ]
    chunks: list[str] = []
    safe_max_chars = max(40, int(max_chars))
    for sentence in sentences or [normalized]:
        if len(sentence) <= safe_max_chars:
            chunks.append(sentence)
            continue

        strong_clauses = [
            clause.strip()
            for clause in re.split(r"\s*[—–]\s*|(?<=[;；:：])\s+", sentence)
            if clause.strip()
        ]
        for clause in strong_clauses or [sentence]:
            for part in _split_oversized_clause(clause, safe_max_chars):
                speech_ready = _speech_ready_clause(part)
                if speech_ready:
                    chunks.append(speech_ready)
    return chunks


def _merge_wav_payloads(payloads: list[bytes], pause_ms: int = SENTENCE_PAUSE_MS) -> bytes:
    if not payloads:
        return b""
    if len(payloads) == 1:
        return payloads[0]

    audio_parts: list[bytes] = []
    output_params: tuple[int, int, int, str, str] | None = None
    for payload in payloads:
        with wave.open(io.BytesIO(payload), "rb") as source:
            current_params = (
                source.getnchannels(),
                source.getsampwidth(),
                source.getframerate(),
                source.getcomptype(),
                source.getcompname(),
            )
            if output_params is None:
                output_params = current_params
            elif current_params != output_params:
                raise ValueError("GPT-SoVITS sentence WAV formats do not match.")
            audio_parts.append(source.readframes(source.getnframes()))

    if output_params is None:
        return b""

    channels, sample_width, sample_rate, compression_type, compression_name = output_params
    silence_frames = max(0, round(sample_rate * max(0, pause_ms) / 1000))
    silence = b"\x00" * silence_frames * channels * sample_width
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(channels)
        target.setsampwidth(sample_width)
        target.setframerate(sample_rate)
        target.setcomptype(compression_type, compression_name)
        for index, audio_part in enumerate(audio_parts):
            if index:
                target.writeframes(silence)
            target.writeframes(audio_part)
    return output.getvalue()


def _request_gptsovits_audio(profile: dict[str, str], text: str) -> bytes:
    request_payload = {
        "text": text,
        "text_language": profile["text_language"],
        "refer_wav_path": os.path.abspath(profile["audio"]),
        "prompt_text": profile["text"],
        "prompt_language": profile["prompt_language"],
        "top_k": 5,
        "top_p": 1,
        "temperature": 1,
    }

    def request_audio() -> requests.Response:
        response = requests.post(
            f"{profile['api_url']}/",
            json=request_payload,
            timeout=300,
        )
        response.raise_for_status()
        return response

    response = request_audio()
    if _is_valid_wav(response.content):
        return response.content

    # GPT-SoVITS can be restarted independently from this vessel. In that
    # case the in-memory model cache is stale and the API may return a valid
    # WAV header with no frames until the selected checkpoints are reloaded.
    # Only retry profiles with explicit checkpoints; generic profiles have no
    # safe model to reload here.
    if profile["gpt_model_path"] and profile["sovits_model_path"]:
        logger.warning(
            "GPT-SoVITS returned empty/invalid audio for profile %s; forcing checkpoint reload and retrying once.",
            profile["profile"],
        )
        _ensure_gptsovits_model(profile, force=True)
        response = request_audio()
        if _is_valid_wav(response.content):
            return response.content

    raise HTTPException(status_code=503, detail="GPT-SoVITS returned empty or invalid WAV audio.")


def _apply_output_gain(payload: bytes, gain_db: str) -> bytes:
    try:
        gain = max(-24.0, min(24.0, float(gain_db)))
    except (TypeError, ValueError):
        logger.warning("Ignoring invalid profile gain value: %r", gain_db)
        return payload

    if abs(gain) < 0.01:
        return payload

    try:
        with wave.open(io.BytesIO(payload), "rb") as source:
            params = source.getparams()
            frames = source.readframes(source.getnframes())

        if params.sampwidth != 2:
            logger.warning("Skipping profile gain for unsupported %s-byte PCM audio.", params.sampwidth)
            return payload

        samples = array("h")
        samples.frombytes(frames)
        if sys.byteorder != "little":
            samples.byteswap()

        multiplier = math.pow(10.0, gain / 20.0)
        peak = max((abs(sample) for sample in samples), default=0)
        if gain > 0 and peak:
            multiplier = min(multiplier, 29204 / peak)
        for index, sample in enumerate(samples):
            samples[index] = max(-32768, min(32767, round(sample * multiplier)))

        if sys.byteorder != "little":
            samples.byteswap()

        output = io.BytesIO()
        with wave.open(output, "wb") as target:
            target.setparams(params)
            target.writeframes(samples.tobytes())
        return output.getvalue()
    except (EOFError, OSError, wave.Error, ValueError):
        logger.exception("Could not apply profile output gain; returning the original WAV.")
        return payload


def _apply_output_pitch(payload: bytes, pitch_semitones: str) -> bytes:
    try:
        semitones = max(-4.0, min(4.0, float(pitch_semitones)))
    except (TypeError, ValueError):
        logger.warning("Ignoring invalid profile pitch value: %r", pitch_semitones)
        return payload

    if abs(semitones) < 0.01:
        return payload

    try:
        with wave.open(io.BytesIO(payload), "rb") as source:
            sample_rate = source.getframerate()
        pitch_ratio = math.pow(2.0, semitones / 12.0)
        tempo_ratio = 1.0 / pitch_ratio
        audio_filter = (
            f"asetrate={sample_rate}*{pitch_ratio:.8f},"
            f"aresample={sample_rate},atempo={tempo_ratio:.8f}"
        )
        ffmpeg_path = os.getenv("LILY_VOICE_FFMPEG_PATH", "ffmpeg").strip() or "ffmpeg"
        with tempfile.TemporaryDirectory(prefix="lily_voice_pitch_") as temp_dir:
            input_path = Path(temp_dir) / "input.wav"
            output_path = Path(temp_dir) / "output.wav"
            input_path.write_bytes(payload)
            process = subprocess.run(
                [
                    ffmpeg_path,
                    "-y",
                    "-v",
                    "error",
                    "-i",
                    str(input_path),
                    "-af",
                    audio_filter,
                    str(output_path),
                ],
                capture_output=True,
                check=False,
                timeout=120,
            )
            if process.returncode != 0 or not output_path.exists():
                detail = process.stderr.decode("utf-8", errors="replace").strip()[:500]
                logger.error("Could not apply profile pitch: %s", detail or f"ffmpeg exit {process.returncode}")
                return payload
            shifted = output_path.read_bytes()
        return shifted if _is_valid_wav(shifted) else payload
    except (EOFError, OSError, subprocess.SubprocessError, wave.Error, ValueError):
        logger.exception("Could not apply profile pitch; returning the original WAV.")
        return payload


def _is_valid_wav(payload: bytes) -> bool:
    if len(payload) <= 44:
        return False

    try:
        with wave.open(io.BytesIO(payload), "rb") as wav_file:
            return wav_file.getnchannels() > 0 and wav_file.getframerate() > 0 and wav_file.getnframes() > 0
    except (EOFError, wave.Error):
        return False


def _absolute_audio_url(request: Request, filename: str) -> str:
    expires = int(time.time()) + AUDIO_URL_TTL_SECONDS
    signature = _audio_signature(filename, expires)
    return (
        f"{str(request.base_url).rstrip('/')}/static/audio/{filename}"
        f"?expires={expires}&signature={signature}"
    )


def _prune_audio_cache() -> None:
    cached = sorted(
        (path for path in AUDIO_DIR.glob("cached_*.wav") if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for stale in cached[CACHE_MAX_FILES:]:
        try:
            stale.unlink()
        except OSError as error:
            logger.warning("Could not remove stale voice cache file %s: %s", stale.name, error)


def _profile_health(profile_id: str) -> dict[str, Any]:
    profile = _profile_from_request(SynthesizeRequest(text="health", voice_language=profile_id, voice_profile=profile_id))
    gpt_configured = bool(profile["gpt_model_path"])
    sovits_configured = bool(profile["sovits_model_path"])
    return {
        "profile": profile["profile"],
        "language": profile["text_language"],
        "api_url": profile["api_url"],
        "reference_ready": bool(profile["audio"]) and os.path.exists(profile["audio"]),
        "model_switch_enabled": gpt_configured and sovits_configured,
        "model_switch_ready": (gpt_configured and sovits_configured) or not (gpt_configured or sovits_configured),
        "gpt_model_configured": gpt_configured,
        "sovits_model_configured": sovits_configured,
        "pitch_semitones": profile["pitch_semitones"],
    }


@app.get("/api/auth/check")
def credential_check(x_lily_token: str | None = Header(default=None)) -> dict:
    """Cheap authenticated probe for credential rotation; never runs a model."""
    import hmac
    if not TOKEN or not hmac.compare_digest(x_lily_token or "", TOKEN):
        raise HTTPException(status_code=401, detail="Invalid service credential")
    return {"authenticated": True, "service": "voice"}


@app.get("/health")
def health(x_lily_token: str | None = Header(default=None)) -> dict[str, Any]:
    _require_token(x_lily_token)
    profiles = [_profile_health(profile_id) for profile_id in _health_profile_ids()]
    default_profile = next((item for item in profiles if item["profile"] == DEFAULT_PROFILE), profiles[0])
    endpoint_url = default_profile["api_url"]

    try:
        response = requests.get(endpoint_url, timeout=2.5)
        endpoint_reachable = response.status_code < 500
        endpoint_status = response.status_code
        endpoint_error = ""
    except Exception as error:
        endpoint_reachable = False
        endpoint_status = None
        endpoint_error = str(error)

    reference_ready = bool(default_profile["reference_ready"])
    model_ready = bool(default_profile["model_switch_ready"])

    if endpoint_reachable and reference_ready and model_ready:
        status = "online"
        detail = "Voice vessel and GPT-SoVITS are ready."
    elif endpoint_reachable:
        status = "degraded"
        detail = "Voice vessel is online, but the active profile still needs reference audio or complete checkpoint config."
    else:
        status = "offline"
        detail = "Voice vessel cannot reach GPT-SoVITS."

    return {
        "status": status,
        "detail": detail,
        "provider": "gptsovits",
        "mode": "voice-vessel",
        "endpoint": endpoint_url,
        "endpoint_reachable": endpoint_reachable,
        "endpoint_status": endpoint_status,
        "error": endpoint_error,
        "default_profile": DEFAULT_PROFILE,
        "profiles": profiles,
        "queue": _queue_snapshot(),
    }


@app.get("/health/live")
def health_live() -> dict[str, str]:
    return {"status": "ok", "service": "lily_voice_vessel"}


@app.post("/api/voice/synthesize")
def synthesize(
    payload: SynthesizeRequest,
    request: Request,
    x_lily_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_token(x_lily_token)
    profile = _profile_from_request(payload)

    if not os.path.exists(profile["audio"]):
        raise HTTPException(status_code=503, detail=f"Reference audio is missing: {profile['audio']}")
    if not profile["text"]:
        raise HTTPException(status_code=503, detail=f"Reference text is missing for profile '{profile['profile']}'.")

    filename = _cache_name(payload.text, profile, SYNTHESIS_CACHE_VERSION)
    output_path = AUDIO_DIR / filename
    audio_url = _absolute_audio_url(request, filename)
    if output_path.exists():
        if _is_valid_wav(output_path.read_bytes()):
            return {
                "status": "ok",
                "audio_url": audio_url,
                "cached": True,
                "queue": _queue_snapshot(),
                "voice_profile": profile["profile"],
                "voice_language": profile["language"],
            }
        output_path.unlink(missing_ok=True)

    _queue_enter()
    try:
        _ensure_gptsovits_model(profile)
        sentence_payloads = [
            _request_gptsovits_audio(profile, sentence)
            for sentence in _split_synthesis_text(payload.text)
        ]
        audio_payload = _merge_wav_payloads(sentence_payloads)
        audio_payload = _apply_output_pitch(audio_payload, profile["pitch_semitones"])
        audio_payload = _apply_output_gain(audio_payload, profile["gain_db"])
        if not _is_valid_wav(audio_payload):
            raise HTTPException(status_code=503, detail="GPT-SoVITS returned empty or invalid WAV audio.")
        output_path.write_bytes(audio_payload)
        _prune_audio_cache()
        _queue_exit(audio_url=audio_url)
        return {
            "status": "ok",
            "audio_url": audio_url,
            "cached": False,
            "queue": _queue_snapshot(),
            "voice_profile": profile["profile"],
            "voice_language": profile["language"],
        }
    except HTTPException as error:
        _queue_exit(error=str(error.detail))
        raise
    except Exception as error:
        _queue_exit(error=str(error))
        logger.exception("Voice synthesis failed.")
        raise HTTPException(status_code=503, detail=f"Voice synthesis failed: {error}") from error


@app.post("/synthesize")
def synthesize_alias(
    payload: SynthesizeRequest,
    request: Request,
    x_lily_token: str | None = Header(default=None),
) -> dict[str, Any]:
    return synthesize(payload, request, x_lily_token)


if __name__ == "__main__":
    uvicorn.run("app:app", host=HOST, port=PORT)
