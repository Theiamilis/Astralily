"""Shared response language, expression, and voice preparation helpers."""
import asyncio
import json
import logging
import re
from .request_progress import report_progress
from typing import Dict

from .settings import settings
from .providers import ProviderError, generate_voice_result, resolve_effective_voice_route, run_text_task
from .audio_stitching import stitch_audio_urls
from .audio_access import sign_core_audio_url
from .tts_sanitizer import sanitize_for_tts
from .tts_chunking import plan_tts_chunks
from .voice_capabilities import resolve_address_term


logger = logging.getLogger("lily.core.handlers")


def _expression_source_metadata(expression_from_directive: str | None) -> str:
    return "llm_directive" if expression_from_directive else "emotion_inferred"


def _resolve_voice_route(context: Dict[str, object]) -> tuple[str | None, str | None]:
    language = str(context.get("voice_language") or context.get("language") or "").strip().lower()
    voice_profile = str(context.get("voice_profile") or "").strip()
    return language or None, voice_profile or None


def _resolve_voice_backend_route(context: Dict[str, object]) -> str | None:
    route = str(context.get("voice_route") or "").strip().lower()
    if route in settings.VOICE_ROUTES or route == "stream_voice":
        return route
    return settings.voice_provider if settings.voice_provider in settings.VOICE_ROUTES else None


def _resolve_stream_voice_backend_route(context: Dict[str, object]) -> str:
    """Resolve a stream route while preserving the legacy strict stream default."""
    requested = str(context.get("voice_route") or "").strip().lower()
    if requested in settings.VOICE_ROUTES or requested in {"stream_stage", "stream_voice"}:
        return requested
    configured = str(settings.stream_stage_voice_route or "stream_stage").strip().lower()
    if configured in settings.VOICE_ROUTES or configured in {"stream_stage", "stream_voice"}:
        return configured
    return "stream_stage"


def _stream_voice_provider_label(route: str) -> str:
    if route in {"stream_stage", "stream_voice", "rvc"}:
        return settings.stream_voice_provider
    return route


def _stream_voice_tts_mode(route: str) -> str:
    if route in {"stream_stage", "stream_voice", "rvc"}:
        return settings.stream_voice_tts_mode
    return route


def _voice_language_instruction(language: str | None) -> str:
    selected = str(language or "").strip().lower()
    if selected.startswith("en"):
        return "Reply in natural English."
    return "Reply in natural Japanese."


def _stream_voice_language(text: str, explicit_language: str | None = None) -> str:
    selected = str(explicit_language or "").strip().lower().replace("_", "-")
    if selected.startswith("ja") or selected in {"jp", "japanese"}:
        return "ja"
    if selected.startswith("id") or selected in {"in", "indonesian", "bahasa"}:
        return "id"
    if selected.startswith("en") or selected == "english":
        return "en"
    if re.search(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]", text):
        return "ja"
    normalized = re.sub(r"[^\w\s']", " ", text.lower(), flags=re.UNICODE)
    if re.search(
        r"\b(aku|gw|gue|gua|saya|kamu|lu|lo|kalian|yang|dan|untuk|dari|ini|itu|apa|gimana|"
        r"kalau|kalo|bisa|mau|lagi|banget|aja|dong|nih|mending|boleh|langsung|pake|"
        r"gak|ga|nggak|ngga|enggak|kgk|udah|sudah|belum|tidak)\b",
        normalized,
    ):
        return "id"
    return "en"


def _normalize_reply_language(value: object | None) -> str:
    language = str(value or "").strip().lower()
    return "en" if language in {"en", "english"} else "id"


def _detect_reply_language(message: str) -> str:
    normalized = re.sub(r"[^\w\s'?]", " ", message.lower(), flags=re.UNICODE)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if not normalized:
        return "id"

    if re.fullmatch(r"(p|ping|halo|hai|mas|bang|kak|mbak|mba)", normalized):
        return "id"

    indonesian_patterns = [
        r"\b(aku|gw|gue|gua|saya|kamu|lu|lo|nih|dong|tolong|nyala|apa|gimana|kalo|kalau|bisa|buat|dah|udah|belum|lagi|lihat|liat|coba|sekarang|nanti|kok|jir|anjay)\b",
        r"\b(gak|ga|nggak|kgk|ngga|enggak)\b",
        r"\b(mending|boleh|langsung|sekalian|benerin|jalanin|kasih|pake|dipake|kenapa|cek|cari)\b",
    ]
    english_patterns = [
        r"\b(hello|hi|please|can you|could you|would you|what|how|why|when|where|which|turn on|wake|computer|search|browse|voice|message)\b",
        r"\b(help|check|show|make|create|fix|update|send|reply|explain|later|now)\b",
    ]

    id_score = sum(len(re.findall(pattern, normalized)) for pattern in indonesian_patterns)
    en_score = sum(len(re.findall(pattern, normalized)) for pattern in english_patterns)
    return "en" if en_score > id_score else "id"


def _resolve_reply_language(payload: Dict[str, object], message: str) -> str:
    explicit = payload.get("reply_language") or payload.get("language") or payload.get("voice_language")
    if explicit:
        return _normalize_reply_language(explicit)
    return _detect_reply_language(message)


def _reply_language_label(reply_language: str) -> str:
    return "English" if _normalize_reply_language(reply_language) == "en" else "Indonesian"


def _reply_language_instruction(reply_language: str) -> str:
    return (
        "Reply in natural English. Match the incoming WhatsApp message language exactly."
        if _normalize_reply_language(reply_language) == "en"
        else "Reply in natural Indonesian. Match the incoming WhatsApp message language exactly."
    )


def _address_term_metadata(context: Dict[str, object], reply_language: str) -> Dict[str, object]:
    term = resolve_address_term(
        reply_language or context.get("language") or context.get("voice_language"),
        context.get("address_term"),
    )
    return {
        "address_term": term["id"],
        "address_term_spoken": term["spoken"],
        "address_term_label": term["label"],
        "address_term_romaji": term.get("romaji", ""),
    }


def _normalize_realm_reply_language(value: object | None) -> str:
    language = str(value or "").strip().lower().replace("_", "-")
    if language.startswith("en") or language == "english":
        return "en"
    if language.startswith("ja") or language in {"jp", "japanese", "japan"}:
        return "ja"
    if language.startswith("id") or language in {
        "in",
        "indonesia",
        "indonesian",
        "bahasa",
        "bahasa indonesia",
    }:
        return "id"
    return ""


def _realm_reply_language_instruction(reply_language: str, requested_address_term: object | None = None) -> str:
    language = _normalize_realm_reply_language(reply_language)
    selected_term = resolve_address_term(language, requested_address_term)
    selected_spoken = selected_term["spoken"]
    if language == "en":
        return (
            "Use English only in the entire visible reply, including pet names and interjections. "
            "Do not mix in Indonesian or Japanese words. In particular, never use 'sayang' in an English reply; "
            f"when an affectionate address fits, use the selected English address '{selected_spoken}' and do not "
            "substitute a different pet name. Proper names, product names, and "
            "technical terms may remain unchanged."
        )
    if language == "ja":
        latin_spelling_rule = (
            "Never spell 'darling' in Latin letters."
            if selected_term["id"] == "darling"
            else "Never substitute an English pet name written in Latin letters."
        )
        return (
            "Use natural Japanese only in the entire visible reply, including pet names and interjections. "
            "Do not mix in Indonesian or English conversational phrases. Proper names, product names, and "
            f"technical terms may remain unchanged. When an affectionate address fits, use the selected Japanese "
            f"address '{selected_spoken}' and do not substitute another address term. {latin_spelling_rule}"
        )
    if language == "id":
        return (
            "Use natural Indonesian only in the entire visible reply, including pet names and interjections. "
            f"Do not mix in English or Japanese conversational phrases. When an affectionate address fits, use "
            f"the selected Indonesian address '{selected_spoken}'. Proper names, product names, and "
            "technical terms may remain unchanged."
        )
    return ""


def _realm_example_reply(reply_language: str, requested_address_term: object | None = None) -> str:
    language = _normalize_realm_reply_language(reply_language)
    selected_spoken = resolve_address_term(language, requested_address_term)["spoken"]
    if language == "id":
        return f"Aku dengar jelas, {selected_spoken}. Ada apa?"
    if language == "ja":
        return f"ちゃんと聞こえてるよ、{selected_spoken}。どうしたの？"
    return f"I can hear you clearly, {selected_spoken}. What's up?"


def _enforce_realm_reply_language(
    text: str,
    reply_language: str,
    requested_address_term: object | None = None,
) -> str:
    """Remove known persona-language leaks without rewriting names or technical terms."""
    language = _normalize_realm_reply_language(reply_language)
    if not text or language not in {"en", "ja"}:
        return text

    selected_term = resolve_address_term(language, requested_address_term)
    selected_spoken = selected_term["spoken"]
    replacements = (
        (
            (r"\bsayangku\b", f"my {selected_spoken}"),
            (r"\bsayang\b", selected_spoken),
            (r"\bayang\b", selected_spoken),
        )
        if language == "en"
        else (
            (r"\bmy\s+love\b", selected_spoken),
            (r"\bdarling\b", selected_spoken),
            (r"\bdear\b", selected_spoken),
            (r"\bsayangku\b", selected_spoken),
            (r"\bsayang\b", selected_spoken),
            (r"\bayang\b", selected_spoken),
        )
    )

    normalized = text
    for pattern, replacement in replacements:
        normalized = re.sub(
            pattern,
            lambda match: replacement.capitalize() if match.group(0)[:1].isupper() else replacement,
            normalized,
            flags=re.IGNORECASE,
        )
    if language == "en":
        alternatives = [term for term in ("love", "darling", "dear") if term != selected_term["id"]]
        if alternatives:
            alternative_pattern = "|".join(re.escape(term) for term in alternatives)
            normalized = re.sub(
                rf"(^|[,!?]\s+)(?:my\s+)?({alternative_pattern})(?=\s*[,!.?]|$)",
                lambda match: (
                    f"{match.group(1)}"
                    f"{selected_spoken.capitalize() if match.group(2)[:1].isupper() else selected_spoken}"
                ),
                normalized,
                flags=re.IGNORECASE,
            )
    if language == "ja":
        normalized = re.sub(
            r"(^|[,!?]\s+)love(?=\s*[,!.?]|$)",
            lambda match: f"{match.group(1)}{selected_spoken}",
            normalized,
            flags=re.IGNORECASE,
        )
    return normalized


def _wa_text(reply_language: str, key: str, **values: object) -> str:
    language = _normalize_reply_language(reply_language)
    task_id = str(values.get("task_id") or "")
    action = str(values.get("action") or "research")
    detail = str(values.get("detail") or "")
    result_note = str(values.get("result_note") or "")
    texts = {
        "tool_create_failed": {
            "id": f"Lily belum bisa masukin tool task itu, sayang. {detail}".strip()
            if detail
            else "Lily belum bisa masukin tool task itu sekarang, sayang.",
            "en": f"Lily could not put that tool task through, love. {detail}".strip()
            if detail
            else "Lily could not put that tool task through right now, love.",
        },
        "delivery_wa": {
            "id": "Nanti hasilnya Lily kirim balik ke chat WhatsApp ini ya.",
            "en": "I will send the result back here on WhatsApp when it is done.",
        },
        "delivery_control": {
            "id": "Nanti hasilnya Lily tampilin di Control Center ya.",
            "en": "I will post the result in Control Center when it is done.",
        },
        "tool_pending": {
            "id": f"Tool task ini butuh izin dulu sebelum jalan.\nID: {task_id}\nAction: {action}\nBisa approve dari Control Center, atau WhatsApp: Lily approve tool <ID>.",
            "en": f"This tool task needs your okay before it runs.\nID: {task_id}\nAction: {action}\nApprove from Control Center, or WhatsApp: Lily approve tool <ID>.",
        },
        "tool_queued": {
            "id": f"Siap, Lily sudah masukin tool task ini.\nID: {task_id}\nAction: {action}\n{result_note}",
            "en": f"Got it. Lily queued that tool task.\nID: {task_id}\nAction: {action}\n{result_note}",
        },
        "secretary_provider_error": {
            "id": "Lily lagi belum bisa nyusun balasan yang pas, jadi pesannya Lily tahan dulu biar nggak jawab asal.",
            "en": "Lily cannot shape a proper reply right now, so she is holding the message instead of answering carelessly.",
        },
    }
    return texts[key][language]


async def _generate_audio_from_final_reply(
    text: str | None,
    emotion: str,
    style: str,
    want_voice: bool,
    language: str | None = None,
    voice_profile: str | None = None,
    voice_route: str | None = None,
) -> tuple[str | None, str]:
    tts_text = sanitize_for_tts(text)
    if not want_voice or not tts_text:
        return None, tts_text

    await report_progress("synthesizing")

    normalized_route = resolve_effective_voice_route(voice_route, language)
    # Stream Stage/TikTok already targets a low-latency voice vessel.  It must
    # remain one short render; chunking those replies would increase live lag.
    chunking_allowed = (
        settings.tts_chunking_enabled
        and normalized_route not in {"stream_stage", "stream_voice", "rvc", "alibaba"}
    )
    chunks = plan_tts_chunks(
        tts_text,
        emotion=emotion,
        style=style,
        max_chars=settings.tts_chunk_max_chars,
        max_words=settings.tts_chunk_max_words,
    ) if chunking_allowed else [tts_text]

    if len(chunks) > 1:
        audio_urls: list[str] = []
        for chunk in chunks:
            if voice_route:
                chunk_audio = await generate_voice_result(
                    chunk,
                    emotion,
                    style,
                    language,
                    voice_profile,
                    voice_route=voice_route,
                )
            else:
                chunk_audio = await generate_voice_result(chunk, emotion, style, language, voice_profile)
            if not chunk_audio:
                logger.warning("TTS chunk %d/%d failed; falling back to one full render.", len(audio_urls) + 1, len(chunks))
                audio_urls = []
                break
            audio_urls.append(chunk_audio)

        if audio_urls:
            stitched_audio = await asyncio.to_thread(
                stitch_audio_urls,
                audio_urls,
                settings.tts_chunk_gap_ms,
            )
            if stitched_audio:
                return sign_core_audio_url(stitched_audio), tts_text
            logger.warning("TTS chunk stitching failed; falling back to one full render.")

    if voice_route:
        audio_url = await generate_voice_result(
            tts_text,
            emotion,
            style,
            language,
            voice_profile,
            voice_route=voice_route,
        )
    else:
        audio_url = await generate_voice_result(tts_text, emotion, style, language, voice_profile)
    return audio_url, tts_text


def _normalize_voice_output_language(value: object | None) -> str:
    language = str(value or "").strip().lower().replace("_", "-")
    if language.startswith("id") or language in {"in", "indo", "indonesian", "bahasa indonesia"}:
        return "id"
    if language.startswith("ja") or language in {"jp", "japanese"}:
        return "ja"
    if language.startswith("en") or language == "english":
        return "en"
    return ""


def _parse_voice_translation(raw: str, target_language: str) -> tuple[str, str]:
    normalized = raw.strip()
    if normalized.startswith("```"):
        normalized = re.sub(r"^```(?:json)?\s*", "", normalized, flags=re.I)
        normalized = re.sub(r"\s*```$", "", normalized)

    start = normalized.find("{")
    end = normalized.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("Voice translation did not return JSON.")

    payload = json.loads(normalized[start : end + 1])
    voice_text = sanitize_for_tts(str(payload.get("voice_text") or ""))
    romanji = " ".join(str(payload.get("romaji") or "").split()) if target_language == "ja" else ""
    if not voice_text:
        raise ValueError("Voice translation returned empty speech text.")
    return voice_text, romanji


async def _prepare_voice_output(
    text: str,
    context: Dict[str, object],
    session: Dict[str, object],
    *,
    enabled: bool,
) -> tuple[str, str, str]:
    sanitized = sanitize_for_tts(text)
    if not enabled or context.get("translate_voice_output") is not True:
        return sanitized, "", ""

    target_language = _normalize_voice_output_language(
        context.get("voice_output_language") or context.get("voice_language")
    )
    source_language = str(context.get("language") or context.get("input_language") or "").strip().lower()
    if not target_language or source_language.startswith(target_language):
        return sanitized, "", ""

    language_name = {"id": "Indonesian", "ja": "Japanese", "en": "English"}[target_language]
    romaji_instruction = (
        "Also provide accurate Hepburn romaji for the Japanese voice_text."
        if target_language == "ja"
        else "Set romaji to an empty string."
    )
    system_prompt = (
        f"Translate assistant dialogue into natural spoken {language_name} for speech synthesis. "
        "Preserve meaning, names, numbers, factual details, emotional tone, and Lily's playful personality. "
        "Do not answer the dialogue, explain it, censor it, or add new information. "
        f"{romaji_instruction} Return only compact valid JSON with exactly these string keys: "
        '"voice_text" and "romaji".'
    )
    translation_request = json.dumps(
        {"source_language": source_language or "auto", "text": sanitized},
        ensure_ascii=False,
    )

    try:
        raw = await run_text_task(
            translation_request,
            system_prompt,
            session,
            max_tokens=320,
            temperature=0.0,
        )
        voice_text, romanji = _parse_voice_translation(raw, target_language)
        return voice_text, romanji, ""
    except (ProviderError, ValueError, TypeError, json.JSONDecodeError) as error:
        return "", "", str(error)[:300]


def _resolve_expression_profile(source: str, context: Dict[str, object] | None = None) -> str:
    interface_name = str((context or {}).get("interface") or "").strip()
    if interface_name in {"lily_private_realm", "lily_mobile_realm", "lily_mobile_realm_android"}:
        return "private_realm"
    if source in {"stream_stage", "tiktok_bridge"}:
        return "stream_stage"
    if source == "wa_bridge":
        return "secretary"
    return "dashboard"


def _resolve_expression_options(context: Dict[str, object] | None = None) -> tuple[str, ...] | None:
    raw_options = (context or {}).get("live2d_expression_options")
    if not isinstance(raw_options, list):
        return None
    allowed = {
        "Love",
        "Soft Love",
        "Blush",
        "Shy",
        "Sparkle Mood",
        "Gloomy",
        "Crying",
        "Sweat",
        "Angry",
    }
    options: list[str] = []
    for raw_value in raw_options:
        value = " ".join(str(raw_value or "").split())
        if value in allowed and value not in options:
            options.append(value)
    return tuple(options) or None
