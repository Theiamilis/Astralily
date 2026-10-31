import json
import re
from typing import Mapping, Sequence


EXPRESSION_OPTIONS = (
    "Love",
    "Soft Love",
    "Blush",
    "Shy",
    "Sparkle Mood",
    "Gloomy",
    "Crying",
    "Sweat",
    "Angry",
)
EXPRESSION_LABELS = ", ".join(EXPRESSION_OPTIONS)

MOOD_EXPRESSION_PRESETS: Mapping[str, str] = {
    "calm": "Blush",
    "sweet": "Soft Love",
    "clingy": "Love",
    "shy": "Shy",
    "chaotic": "Sparkle Mood",
    "sulky": "Gloomy",
    "overwhelmed": "Crying",
    "worried": "Sweat",
    "jealous": "Angry",
}

_EXPRESSION_DIRECTIVE_RE = re.compile(
    r"^\s*(?:"
    r"\[(?:expression|expr|face)\s*:\s*([^\]]+)\]|"
    r"<\s*(?:expression|expr|face)\s*:\s*([^>]+)>|"
    r"(?:expression|expr|face)\s*:\s*([^\n]+)\n"
    r")",
    re.IGNORECASE,
)

_DEFAULT_EXPRESSION_ALIASES = {
    "happy": "Love",
    "joy": "Love",
    "cheer": "Love",
    "cheerful": "Love",
    "love": "Love",
    "excited": "Sparkle Mood",
    "sparkle": "Sparkle Mood",
    "sparkle mood": "Sparkle Mood",
    "soft": "Soft Love",
    "soft love": "Soft Love",
    "cute": "Soft Love",
    "sweet": "Soft Love",
    "clingy": "Love",
    "blush": "Blush",
    "shy": "Shy",
    "embarrassed": "Shy",
    "neutral": "Blush",
    "calm": "Blush",
    "sad": "Gloomy",
    "gloomy": "Gloomy",
    "sulky": "Gloomy",
    "pouty": "Gloomy",
    "worried": "Sweat",
    "cry": "Crying",
    "crying": "Crying",
    "teary": "Crying",
    "overwhelmed": "Crying",
    "sweat": "Sweat",
    "nervous": "Sweat",
    "awkward": "Sweat",
    "angry": "Angry",
    "annoyed": "Angry",
    "jealous": "Angry",
    "warning": "Angry",
    "serious": "Angry",
    "chaotic": "Sparkle Mood",
}

_PROFILE_EXPRESSION_ALIASES: Mapping[str, Mapping[str, str]] = {
    "private_realm": {
        "happy": "Soft Love",
        "joy": "Soft Love",
        "cheer": "Sparkle Mood",
        "cheerful": "Sparkle Mood",
        "cute": "Soft Love",
        "sweet": "Soft Love",
        "neutral": "Blush",
        "calm": "Blush",
        "worried": "Shy",
        "nervous": "Shy",
    },
    "stream_stage": {
        "happy": "Sparkle Mood",
        "joy": "Sparkle Mood",
        "cheer": "Sparkle Mood",
        "cheerful": "Sparkle Mood",
        "excited": "Sparkle Mood",
        "cute": "Love",
        "sweet": "Love",
        "neutral": "Blush",
        "calm": "Blush",
    },
    "secretary": {
        "happy": "Blush",
        "joy": "Blush",
        "cheerful": "Blush",
        "neutral": "Blush",
        "serious": "Sweat",
        "warning": "Sweat",
    },
}

_PROFILE_EXPRESSION_HINTS = {
    "private_realm": (
        "Use the model presets exactly: sweet=Soft Love, clingy=Love, shy=Shy, chaotic=Sparkle Mood, "
        "sulky=Gloomy, overwhelmed=Crying, worried=Sweat, jealous=Angry, and calm=Blush."
    ),
    "stream_stage": "Prefer Sparkle Mood, Love, Sweat, Crying, or Angry for visible live-stage reactions.",
    "secretary": "Prefer Blush, Sweat, or Gloomy for polite secretary replies.",
    "dashboard": "Prefer Blush, Love, Sparkle Mood, or Angry for dashboard replies.",
}


def expression_for_mood(mood: str | None) -> str:
    normalized = re.sub(r"\s+", " ", str(mood or "")).strip().lower()
    return MOOD_EXPRESSION_PRESETS.get(normalized, "Blush")


def _available_options(options: Sequence[str] | None) -> tuple[str, ...]:
    if options is None:
        return EXPRESSION_OPTIONS
    cleaned: list[str] = []
    for value in options:
        normalized = re.sub(r"\s+", " ", str(value or "")).strip()
        if normalized and normalized in EXPRESSION_OPTIONS and normalized not in cleaned:
            cleaned.append(normalized)
    return tuple(cleaned) or EXPRESSION_OPTIONS


def normalize_expression(
    value: str | None,
    profile: str = "dashboard",
    options: Sequence[str] | None = None,
) -> str | None:
    if not value:
        return None

    cleaned = re.sub(r"\s+", " ", value).strip().strip(".,;:!?\"'")
    if not cleaned:
        return None

    available = _available_options(options)
    allowed = {name.lower(): name for name in available}
    exact = allowed.get(cleaned.lower())
    if exact:
        return exact

    profile_aliases = _PROFILE_EXPRESSION_ALIASES.get(profile, {})
    canonical = profile_aliases.get(cleaned.lower()) or _DEFAULT_EXPRESSION_ALIASES.get(cleaned.lower())
    return canonical if canonical in available else None


def infer_emotion(text: str) -> str:
    lowered = text.lower()
    if any(keyword in lowered for keyword in ("awas", "danger", "watch out", "musuh", "boss")):
        return "warning"
    if any(keyword in lowered for keyword in ("cute", "lucu", "love", "sweet")):
        return "happy"
    if any(keyword in lowered for keyword in ("sedih", "sad", "cry", "nangis")):
        return "sad"
    if any(keyword in lowered for keyword in ("marah", "angry", "greedy", "stop")):
        return "angry"
    return "neutral"


def infer_expression(
    emotion: str,
    profile: str = "dashboard",
    options: Sequence[str] | None = None,
) -> str:
    profile_maps = {
        "private_realm": {
            "warning": "Sweat",
            "happy": "Soft Love",
            "sad": "Gloomy",
            "angry": "Angry",
            "neutral": "Blush",
        },
        "stream_stage": {
            "warning": "Angry",
            "happy": "Sparkle Mood",
            "sad": "Crying",
            "angry": "Angry",
            "neutral": "Blush",
        },
        "secretary": {
            "warning": "Sweat",
            "happy": "Blush",
            "sad": "Gloomy",
            "angry": "Sweat",
            "neutral": "Blush",
        },
    }
    default_map = {
        "warning": "Angry",
        "happy": "Love",
        "sad": "Gloomy",
        "angry": "Angry",
        "neutral": "Blush",
    }
    available = _available_options(options)
    preferred = profile_maps.get(profile, default_map).get(emotion, "Blush")
    if preferred in available:
        return preferred
    fallback_order = {
        "warning": ("Angry", "Sweat", "Gloomy", "Blush"),
        "happy": ("Love", "Soft Love", "Sparkle Mood", "Blush"),
        "sad": ("Gloomy", "Crying", "Sweat", "Blush"),
        "angry": ("Angry", "Gloomy", "Sweat", "Blush"),
        "neutral": ("Blush", "Soft Love", "Love", "Shy"),
    }
    return next((item for item in fallback_order.get(emotion, ()) if item in available), available[0])


def expression_protocol_instruction(
    profile: str = "dashboard",
    options: Sequence[str] | None = None,
) -> str:
    available = _available_options(options)
    labels = ", ".join(available)
    preference = (
        _PROFILE_EXPRESSION_HINTS.get(profile, _PROFILE_EXPRESSION_HINTS["dashboard"])
        if options is None
        else "Choose the closest emotional match from the available values."
    )
    return (
        "Output format is strict. First line must be compact JSON only: "
        "{\"expression\":\"<one allowed expression>\"}. "
        "Second line is the spoken reply only. "
        f"Allowed expression values: {labels}. "
        f"{preference} "
        "The JSON is hidden control metadata and will be removed before delivery. "
        "Never mention JSON, metadata, expressions, presets, or Live2D in the spoken reply."
    )


def _consume_json_directive(
    text: str,
    profile: str,
    options: Sequence[str] | None = None,
) -> tuple[str, str | None, bool]:
    cleaned = text.lstrip()
    if not cleaned:
        return text, None, False

    json_text = cleaned
    trailing_text = ""
    if cleaned.startswith("```"):
        opening_end = cleaned.find("\n")
        if opening_end < 0:
            return text, None, False
        closing_match = re.search(r"(?m)^\s*```\s*$", cleaned[opening_end + 1 :])
        if not closing_match:
            return text, None, False
        closing_start = opening_end + 1 + closing_match.start()
        closing_end = opening_end + 1 + closing_match.end()
        json_text = cleaned[opening_end + 1 : closing_start].strip()
        trailing_text = cleaned[closing_end:].strip()

    if not json_text.startswith("{"):
        return text, None, False

    try:
        payload, consumed_chars = json.JSONDecoder().raw_decode(json_text)
    except (json.JSONDecodeError, TypeError):
        return text, None, False

    if not isinstance(payload, dict) or not any(key in payload for key in ("expression", "reply", "text")):
        return text, None, False

    expression = normalize_expression(str(payload.get("expression") or ""), profile, options)
    reply_from_json = str(payload.get("reply") or payload.get("text") or "").strip()
    if not trailing_text:
        trailing_text = json_text[consumed_chars:].strip()
    rest = trailing_text or reply_from_json
    return rest, expression, True


def split_expression_directive(
    text: str,
    profile: str = "dashboard",
    options: Sequence[str] | None = None,
) -> tuple[str, str | None]:
    cleaned = text.strip()
    expression = None
    has_directive = False

    for _ in range(3):
        cleaned, json_expression, did_consume_json = _consume_json_directive(cleaned, profile, options)
        if did_consume_json:
            has_directive = True
            expression = json_expression or expression
            cleaned = cleaned.strip()
            continue

        match = _EXPRESSION_DIRECTIVE_RE.match(cleaned)
        if not match:
            break

        has_directive = True
        raw_expression = next((group for group in match.groups() if group), None)
        expression = normalize_expression(raw_expression, profile, options) or expression
        cleaned = cleaned[match.end() :].strip()

    if cleaned:
        return cleaned, expression

    return ("", expression) if has_directive else (text.strip(), expression)
