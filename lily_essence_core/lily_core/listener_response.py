"""Complete device-local replies that owner tool handlers return as text."""
from .response_support import (
    _generate_audio_from_final_reply,
    _prepare_voice_output,
    _resolve_voice_backend_route,
    _resolve_voice_route,
)
from .schemas import CoreResult, IngestRequest


async def complete_listener_reply(result: CoreResult, request: IngestRequest, session: dict) -> None:
    result.reply_target = "listener"
    result.metadata.update(source="listener", audio_target="listener", device_id=request.payload["device_id"])
    # Handlers that already attempted TTS must not trigger a duplicate request on failure.
    if not result.text or result.audio_url or "tts_text" in result.metadata or not request.payload.get("want_voice"):
        return
    context = request.payload.get("context")
    context = context if isinstance(context, dict) else {}
    language, profile = _resolve_voice_route(context)
    text, romanji, translation_error = await _prepare_voice_output(result.text, context, session, enabled=True)
    result.audio_url, tts_text = await _generate_audio_from_final_reply(
        text, result.emotion or "neutral", "owner_chat", True, language, profile,
        voice_route=_resolve_voice_backend_route(context),
    )
    result.metadata.update(tts_text=tts_text, tts_sanitized=True, voice_text=text,
                           voice_romanji=romanji, voice_translation_error=translation_error)
