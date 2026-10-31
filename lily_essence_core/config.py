import os
from pathlib import Path

from dotenv import load_dotenv

# Load environment variables from this component's .env file.
load_dotenv(Path(__file__).resolve().parent / ".env")

CORE_DIR = Path(__file__).resolve().parent


def _resolve_core_path(path: str) -> str:
    if not path:
        return path
    candidate = Path(path)
    if candidate.is_absolute():
        return str(candidate)
    return str(CORE_DIR / candidate)

# OpenAI API settings
OPENAI_API_BASE = os.getenv("OPENAI_API_BASE", "http://127.0.0.1:1234/v1")

# GPT-SoVITS API URL
GPTSOVITS_API_URL = os.getenv("GPTSOVITS_API_URL", "http://127.0.0.1:10880").rstrip("/")

# GPT-SoVITS reference configuration.
# Voice profiles use stable language IDs so the actual SoVITS model can be
# swapped later without leaking model names into API/UI contracts.
REF_AUDIO_PATH = _resolve_core_path(os.getenv("REF_AUDIO_PATH", "static/ref_voice.wav"))
REF_TEXT_PATH = _resolve_core_path(os.getenv("REF_TEXT_PATH", "static/ref_text.txt"))
REF_TEXT_CONTENT = os.getenv(
    "REF_TEXT_CONTENT",
    "I think it's a good idea to have the reload there because sometimes in movies, sometimes they don't reload.",
)

DEFAULT_VOICE_LANGUAGE = os.getenv("LILY_VOICE_LANGUAGE", "ja").strip().lower()

VOICE_PROFILE_BY_LANGUAGE = {
    "ja": os.getenv("LILY_VOICE_PROFILE_JA", "ja").strip(),
    "id": os.getenv("LILY_VOICE_PROFILE_JA", "ja").strip(),
    "en": os.getenv("LILY_VOICE_PROFILE_EN", "en").strip(),
}

VOICE_PROFILE_DEFAULTS = {
    "ja": {
        "audio": "../local_assets/voice_models/gpt-sovits/neptune/references/neutral.wav",
        "text": "こんにちは、リリーです。今日もそばにいて、あなたを手伝います。",
        "language": "ja",
        "text_language": "ja",
        "prompt_language": "ja",
        "api_url": GPTSOVITS_API_URL,
        "gpt_model_path": "",
        "sovits_model_path": "",
    },
    "en": {
        "audio": "static/ref_voice_en.wav",
        "text": "Hi, I'm Lily. I'm ready to keep you company and help today.",
        "language": "en",
        "text_language": "en",
        "prompt_language": "en",
        "api_url": GPTSOVITS_API_URL,
        "gpt_model_path": "",
        "sovits_model_path": "",
    },
}


def normalize_voice_language(language: str | None) -> str:
    selected = (language or DEFAULT_VOICE_LANGUAGE or "ja").strip().lower()
    if selected.startswith("en"):
        return "en"
    return "ja"


def normalize_voice_profile(profile_id: str | None) -> str | None:
    selected = (profile_id or "").strip().lower()
    if not selected:
        return None
    if selected in {"id", "indonesian", "jp", "japanese"}:
        return "ja"
    return selected


def _profile_env_key(profile_id: str) -> str:
    return "".join(char if char.isalnum() else "_" for char in profile_id.upper()).strip("_")


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
        "normal": "neutral",
        "calm": "neutral",
        "joy": "happy",
        "cheer": "happy",
        "cheerful": "happy",
        "love": "happy",
        "soft": "happy",
        "sweet": "happy",
        "cute": "happy",
        "gloomy": "sad",
        "cry": "sad",
        "crying": "sad",
        "teary": "sad",
        "warning": "angry",
        "annoyed": "angry",
        "serious": "angry",
    }
    alias = aliases.get(raw_emotion)
    if alias:
        _append(alias)

    return candidates


def _read_text_file(path: str, fallback: str) -> str:
    resolved_path = _resolve_core_path(path)
    if resolved_path and os.path.exists(resolved_path):
        with open(resolved_path, "r", encoding="utf-8") as file:
            value = file.read().strip()
            if value:
                return value
    return fallback


def _apply_emotion_overrides(
    profile_env_key: str,
    emotion: str,
    audio_path: str,
    text_content: str,
    text_language: str,
    prompt_language: str,
) -> tuple[str, str, str, str, bool]:
    for emotion_key in _emotion_env_keys(emotion):
        prefix = f"LILY_VOICE_PROFILE_{profile_env_key}_EMOTION_{emotion_key}"
        raw_audio = os.getenv(f"{prefix}_REF_AUDIO", "").strip()
        raw_text = os.getenv(f"{prefix}_REF_TEXT", "")
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

        resolved_audio = _resolve_core_path(raw_audio) if raw_audio else audio_path
        resolved_text = text_content
        if raw_text_path:
            resolved_text = _read_text_file(raw_text_path, raw_text or text_content)
        elif raw_text:
            resolved_text = raw_text

        return (
            resolved_audio,
            resolved_text,
            raw_text_language or text_language,
            raw_prompt_language or prompt_language,
            True,
        )

    return audio_path, text_content, text_language, prompt_language, False


def get_voice_profile(
    profile_id: str | None = None,
    language: str | None = None,
    emotion: str = "normal",
) -> dict[str, str]:
    """Resolve a SoVITS voice profile for a language/emotion pair."""
    voice_language = normalize_voice_language(language)
    normalized_profile_id = normalize_voice_profile(profile_id)
    selected_profile = (
        normalized_profile_id
        or VOICE_PROFILE_BY_LANGUAGE.get(voice_language)
        or VOICE_PROFILE_BY_LANGUAGE["ja"]
    ).strip()

    defaults = VOICE_PROFILE_DEFAULTS.get(
        selected_profile,
        {
            "audio": REF_AUDIO_PATH,
            "text": REF_TEXT_CONTENT,
            "language": voice_language,
            "text_language": "auto",
            "prompt_language": "auto",
            "api_url": GPTSOVITS_API_URL,
            "gpt_model_path": "",
            "sovits_model_path": "",
        },
    )
    env_key = _profile_env_key(selected_profile)

    audio_path = _resolve_core_path(
        os.getenv(f"LILY_VOICE_PROFILE_{env_key}_REF_AUDIO", defaults["audio"]).strip()
    )
    text_fallback = os.getenv(f"LILY_VOICE_PROFILE_{env_key}_REF_TEXT", defaults["text"])
    text_path = os.getenv(f"LILY_VOICE_PROFILE_{env_key}_REF_TEXT_PATH", "").strip()
    text_content = _read_text_file(text_path, text_fallback) if text_path else text_fallback
    text_language = os.getenv(
        f"LILY_VOICE_PROFILE_{env_key}_TEXT_LANGUAGE",
        defaults.get("text_language", defaults["language"]),
    ).strip().lower()
    prompt_language = os.getenv(
        f"LILY_VOICE_PROFILE_{env_key}_PROMPT_LANGUAGE",
        defaults.get("prompt_language", text_language),
    ).strip().lower()
    api_url = os.getenv(
        f"LILY_VOICE_PROFILE_{env_key}_API_URL",
        defaults.get("api_url", GPTSOVITS_API_URL),
    ).strip().rstrip("/")
    gpt_model_path = os.getenv(
        f"LILY_VOICE_PROFILE_{env_key}_GPT_MODEL_PATH",
        defaults.get("gpt_model_path", ""),
    ).strip()
    sovits_model_path = os.getenv(
        f"LILY_VOICE_PROFILE_{env_key}_SOVITS_MODEL_PATH",
        defaults.get("sovits_model_path", ""),
    ).strip()

    audio_path, text_content, text_language, prompt_language, has_emotion_override = _apply_emotion_overrides(
        env_key,
        emotion,
        audio_path,
        text_content,
        text_language,
        prompt_language,
    )

    if not has_emotion_override and emotion != "normal":
        emotion_audio = _resolve_core_path(f"static/ref_{emotion}.wav")
        emotion_text_file = _resolve_core_path(f"static/ref_{emotion}.txt")
        if os.path.exists(emotion_audio):
            audio_path = emotion_audio
            text_content = _read_text_file(emotion_text_file, text_content)
    elif not os.path.exists(audio_path) and os.path.exists(REF_AUDIO_PATH):
        # Keep voice generation alive while profile-specific refs are being prepared.
        audio_path = REF_AUDIO_PATH

    return {
        "audio": audio_path,
        "text": text_content,
        "language": voice_language,
        "profile": selected_profile,
        "text_language": text_language,
        "prompt_language": prompt_language,
        "api_url": api_url or GPTSOVITS_API_URL,
        "gpt_model_path": gpt_model_path,
        "sovits_model_path": sovits_model_path,
    }


def get_emotion_ref(emotion: str) -> dict[str, str]:
    """Backward compatible emotion lookup for older callers."""
    return get_voice_profile(language=DEFAULT_VOICE_LANGUAGE, emotion=emotion)

# Gemini API Key (for ROUTE_CLOUD heavy tasks)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MAX_REQUESTS_PER_MINUTE = int(os.getenv("GEMINI_MAX_REQUESTS_PER_MINUTE", "8"))
