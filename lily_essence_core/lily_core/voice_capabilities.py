"""Canonical voice, STT, and affectionate-address capabilities for Lily clients."""

from __future__ import annotations

from typing import Any


VOICE_ROUTE_CAPABILITIES: dict[str, dict[str, Any]] = {
    "sovits": {
        "label": "SoVITS",
        "detail": "Local or registered GPT-SoVITS voice",
        "languages": ["id", "en", "ja"],
        "supports_emotion": True,
        "supports_romanji": True,
        "emotion_mode": "native",
        "style_mode": "native",
        "strict": False,
    },
    "sovits2": {
        "label": "SoVITS 2",
        "detail": "Second dedicated GPT-SoVITS vessel",
        "languages": ["id", "en", "ja"],
        "supports_emotion": True,
        "supports_romanji": True,
        "emotion_mode": "native",
        "style_mode": "native",
        "strict": True,
    },
    "rvc": {
        "label": "RVC",
        "detail": "Stream Voice vessel with Edge/Google TTS and RVC",
        "languages": ["id", "en", "ja"],
        "supports_emotion": False,
        "supports_romanji": True,
        "emotion_mode": "metadata_only",
        "style_mode": "metadata_only",
        "strict": True,
    },
    "alibaba": {
        "label": "Alibaba",
        "detail": "Alibaba Qwen-Audio-TTS natural voice route",
        "languages": ["id", "en", "ja"],
        "supports_emotion": False,
        "supports_romanji": True,
        "emotion_mode": "metadata_only",
        "style_mode": "metadata_only",
        "strict": True,
    },
}


ADDRESS_TERMS: dict[str, list[dict[str, str]]] = {
    "id": [
        {"id": "sayang", "label": "Sayang", "spoken": "sayang", "detail": "Natural and warm"},
        {"id": "cintaku", "label": "Cintaku", "spoken": "cintaku", "detail": "More romantic"},
        {"id": "beb", "label": "Beb", "spoken": "beb", "detail": "Casual and playful"},
    ],
    "en": [
        {"id": "love", "label": "Love", "spoken": "love", "detail": "Natural and warm"},
        {"id": "darling", "label": "Darling", "spoken": "darling", "detail": "Romantic"},
        {"id": "dear", "label": "Dear", "spoken": "dear", "detail": "Soft and gentle"},
    ],
    "ja": [
        {
            "id": "darling",
            "label": "ダーリン",
            "spoken": "ダーリン",
            "romaji": "dārin",
            "detail": "Romantic; natural TTS spelling",
        },
        {
            "id": "anata",
            "label": "あなた",
            "spoken": "あなた",
            "romaji": "anata",
            "detail": "Intimate, spouse-like",
        },
        {
            "id": "kimi",
            "label": "君",
            "spoken": "君",
            "romaji": "kimi",
            "detail": "Close and casual",
        },
    ],
}


DEFAULT_ADDRESS_TERM = {"id": "sayang", "en": "love", "ja": "darling"}


def normalize_language(value: object | None) -> str:
    normalized = str(value or "").strip().lower().replace("_", "-")
    if normalized.startswith("ja") or normalized in {"jp", "japanese"}:
        return "ja"
    if normalized.startswith("en") or normalized == "english":
        return "en"
    return "id"


def address_term_options(language: object | None) -> list[dict[str, str]]:
    return [dict(option) for option in ADDRESS_TERMS[normalize_language(language)]]


def resolve_address_term(language: object | None, requested: object | None) -> dict[str, str]:
    normalized_language = normalize_language(language)
    requested_id = str(requested or "").strip().lower()
    options = ADDRESS_TERMS[normalized_language]
    selected = next((option for option in options if option["id"] == requested_id), None)
    return dict(selected or next(option for option in options if option["id"] == DEFAULT_ADDRESS_TERM[normalized_language]))


def address_term_prompt(language: object | None, requested: object | None) -> str:
    term = resolve_address_term(language, requested)
    language_id = normalize_language(language)
    if language_id == "ja":
        return (
            f"Use the selected affectionate address naturally when it fits: {term['spoken']} "
            f"({term.get('romaji', '')}). Never write the English word 'darling' in a Japanese reply."
        )
    return f"Use the selected affectionate address naturally when it fits: {term['spoken']}. Do not force it into every reply."


def public_capabilities() -> dict[str, Any]:
    return {
        "voice_routes": {
            route_id: {key: value for key, value in capability.items()}
            for route_id, capability in VOICE_ROUTE_CAPABILITIES.items()
        },
        "stt": {
            "languages": ["id", "en", "ja"],
            "states": [
                "listening",
                "recording",
                "silence_detected",
                "uploading",
                "transcribing",
                "retrying",
                "complete",
                "failed",
            ],
            "error_codes": ["permission", "empty_audio", "duration", "network", "provider", "unknown"],
            "vad": {
                "enabled": True,
                "mode": "client_auto_stop_and_server_filter",
                "silence_ms": 1100,
                "start_timeout_ms": 6000,
            },
        },
        "address_terms": {language: address_term_options(language) for language in ADDRESS_TERMS},
        "voice_contract": {
            "request_fields": ["text", "emotion", "style", "voice_language", "voice_profile"],
            "metadata_fields": ["voice_route", "voice_provider", "voice_language", "voice_profile"],
            "strict_routes": [
                route_id
                for route_id, capability in VOICE_ROUTE_CAPABILITIES.items()
                if capability["strict"]
            ],
        },
    }
