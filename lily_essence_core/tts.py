import logging
import requests
import os
import uuid
import hashlib
from pathlib import Path
from threading import Lock

from config import get_voice_profile
from lily_core.audio_access import prune_core_audio_cache

# TTS Stream Mode: "batch" (wait for full audio) or "stream" (chunked streaming)
TTS_STREAM_MODE = os.getenv("TTS_STREAM_MODE", "batch")
CORE_DIR = Path(__file__).resolve().parent
STATIC_AUDIO_DIR = CORE_DIR / "static" / "audio"
_MODEL_SWITCH_LOCK = Lock()
_ACTIVE_MODEL_BY_API_URL: dict[str, tuple[str, str]] = {}


def _voice_cache_key(text: str, emotion: str, ref_data: dict[str, str], mode: str = "batch") -> str:
    return "|".join(
        [
            text,
            emotion,
            ref_data["language"],
            ref_data["profile"],
            ref_data["api_url"],
            ref_data.get("gpt_model_path", ""),
            ref_data.get("sovits_model_path", ""),
            mode,
        ]
    )


def _ensure_gptsovits_model(ref_data: dict[str, str]) -> bool:
    """Switch GPT-SoVITS checkpoints when a voice profile declares them."""
    gpt_model_path = ref_data.get("gpt_model_path", "")
    sovits_model_path = ref_data.get("sovits_model_path", "")
    if not gpt_model_path and not sovits_model_path:
        return True
    if not gpt_model_path or not sovits_model_path:
        logging.error(
            "[TTS MODEL] Voice profile '%s' must define both GPT and SoVITS model paths.",
            ref_data["profile"],
        )
        return False

    api_url = ref_data["api_url"]
    desired_model = (gpt_model_path, sovits_model_path)

    with _MODEL_SWITCH_LOCK:
        if _ACTIVE_MODEL_BY_API_URL.get(api_url) == desired_model:
            return True

        try:
            response = requests.post(
                f"{api_url}/set_model",
                json={
                    "gpt_model_path": gpt_model_path,
                    "sovits_model_path": sovits_model_path,
                },
                timeout=180,
            )
            if response.status_code != 200:
                logging.error("[TTS MODEL] GPT-SoVITS set_model failed: %s", response.text)
                return False

            payload = response.json()
            if payload.get("code") != 0:
                logging.error("[TTS MODEL] GPT-SoVITS rejected model switch: %s", payload)
                return False

            _ACTIVE_MODEL_BY_API_URL[api_url] = desired_model
            logging.info("[TTS MODEL] Switched GPT-SoVITS profile '%s'.", ref_data["profile"])
            return True
        except Exception as exc:
            logging.error("[TTS MODEL] GPT-SoVITS model switch exception: %s", exc)
            return False


def generate_voice(
    text: str,
    speaker_id: int = 14,
    emotion: str = "normal",
    language: str | None = None,
    voice_profile: str | None = None,
):
    """
    Dispatcher for TTS generation.
    Returns:
      - batch mode: file path string (e.g. "/static/audio/xxx.wav")
      - stream mode: a generator that yields audio chunks
    """
    if TTS_STREAM_MODE == "stream":
        return generate_gptsovits_stream(text, emotion, language, voice_profile)
    return generate_gptsovits_voice(text, emotion, language, voice_profile)


def generate_gptsovits_voice(
    text: str,
    emotion: str = "normal",
    language: str | None = None,
    voice_profile: str | None = None,
):
    """
    [BATCH MODE] Generate voice using GPT-SoVITS API.
    Waits for full audio, saves to file, returns path.
    """
    ref_data = get_voice_profile(voice_profile, language, emotion)
    logging.info(
        "[TTS BATCH] Generating GPT-SoVITS for: %s | Emotion: %s | Language: %s | Voice: %s",
        text,
        emotion,
        ref_data["language"],
        ref_data["profile"],
    )

    # Check reference audio
    if not os.path.exists(ref_data["audio"]):
        logging.error(f"Ref audio not found at {ref_data['audio']}, cannot generate voice.")
        return None

    # --- TTS CACHING LOGIC ---
    # Include the voice route in the cache key so ID/EN voices do not collide.
    cache_key = _voice_cache_key(text, emotion, ref_data)
    text_hash = hashlib.md5(cache_key.encode("utf-8")).hexdigest()
    cache_filename = f"cached_{text_hash}.wav"
    cache_filepath = STATIC_AUDIO_DIR / cache_filename
    
    # If this exact text has been rendered before, return the cached file instantly
    if cache_filepath.exists():
        prune_core_audio_cache(STATIC_AUDIO_DIR)
        logging.info(f"[TTS CACHE] Found cached audio for: '{text[:20]}...'")
        return f"/static/audio/{cache_filename}"

    if not _ensure_gptsovits_model(ref_data):
        return None

    try:
        payload = {
            "text": text,
            "text_language": ref_data["text_language"],
            "refer_wav_path": os.path.abspath(ref_data["audio"]),
            "prompt_text": ref_data["text"],
            "prompt_language": ref_data["prompt_language"],
            "top_k": 5,
            "top_p": 1,
            "temperature": 1
        }
        
        response = requests.post(
            f"{ref_data['api_url']}/", 
            json=payload,
            timeout=300
        )

        if response.status_code != 200:
            logging.error(f"GPT-SoVITS Error: {response.text}")
            return None

        # Save to static and return the path using the cached filename
        return save_audio_to_static(response.content, filename=cache_filename)

    except Exception as e:
        logging.error(f"GPT-SoVITS Exception: {e}")
        return None


def generate_gptsovits_stream(
    text: str,
    emotion: str = "normal",
    language: str | None = None,
    voice_profile: str | None = None,
):
    """
    [STREAM MODE] Generate voice using GPT-SoVITS API with chunked streaming.
    Returns a generator that yields audio bytes as they arrive.
    GPT-SoVITS must be started with: -sm normal -mt ogg
    """
    ref_data = get_voice_profile(voice_profile, language, emotion)
    logging.info(
        "[TTS STREAM] Streaming GPT-SoVITS for: %s | Emotion: %s | Language: %s | Voice: %s",
        text,
        emotion,
        ref_data["language"],
        ref_data["profile"],
    )

    if not os.path.exists(ref_data["audio"]):
        logging.warning(f"Ref audio not found at {ref_data['audio']}")
        return None

    # --- TTS CACHING LOGIC (STREAM) ---
    cache_key = _voice_cache_key(text, emotion, ref_data, "stream")
    text_hash = hashlib.md5(cache_key.encode("utf-8")).hexdigest()
    cache_filename = f"cached_stream_{text_hash}.ogg"
    cache_filepath = STATIC_AUDIO_DIR / cache_filename
    
    # If cached stream exists, stream it from disk!
    if cache_filepath.exists():
        logging.info(f"[TTS CACHE] Streaming cached audio for: '{text[:20]}...'")
        def file_chunk_generator():
            with open(cache_filepath, "rb") as f:
                while chunk := f.read(4096):
                    yield chunk
        return file_chunk_generator()

    if not _ensure_gptsovits_model(ref_data):
        return None

    try:
        payload = {
            "text": text,
            "text_language": ref_data["text_language"],
            "refer_wav_path": os.path.abspath(ref_data["audio"]),
            "prompt_text": ref_data["text"],
            "prompt_language": ref_data["prompt_language"],
            "top_k": 5,
            "top_p": 1,
            "temperature": 1
        }

        # Use stream=True for chunked transfer
        response = requests.post(
            f"{ref_data['api_url']}/",
            json=payload,
            timeout=300,
            stream=True
        )

        if response.status_code != 200:
            logging.error(f"GPT-SoVITS Stream Error: {response.text}")
            return None

        def audio_chunk_generator():
            # Create the file and write chunks to cache it while streaming to the user
            STATIC_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
            with open(cache_filepath, "wb") as f:
                for chunk in response.iter_content(chunk_size=4096):
                    if chunk:
                        f.write(chunk)
                        yield chunk
            prune_core_audio_cache(STATIC_AUDIO_DIR)

        return audio_chunk_generator()

    except Exception as e:
        logging.error(f"GPT-SoVITS Stream Exception: {e}")
        return None


def save_audio_to_static(audio_content, filename: str = None):
    """Helper to save binary audio content to static folder. Uses a specific filename if provided, otherwise a UUID."""
    if filename is None:
        filename = f"{uuid.uuid4()}.wav"
        
    STATIC_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    file_path = STATIC_AUDIO_DIR / filename
    
    with open(file_path, "wb") as audio_file:
        audio_file.write(audio_content)
    prune_core_audio_cache(STATIC_AUDIO_DIR)
        
    return f"/static/audio/{filename}"


def process_with_rvc(audio_path: str) -> str:
    """Dummy function for RVC processing. Replace with actual implementation."""
    return audio_path

