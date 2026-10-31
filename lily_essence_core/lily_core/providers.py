import base64
import asyncio
import logging
import os
import time
import uuid
from collections import deque
from threading import Lock
from typing import Any, Dict, Optional
from urllib.parse import urljoin, urlparse

import openai
import requests

from tts import generate_voice, save_audio_to_static
from config import get_voice_profile

from .settings import settings
from .prompt_store import get_prompt
from .tts_sanitizer import sanitize_for_tts
from .audio_access import sign_core_audio_url
from .voice_registry import VoiceNodeConfig

logger = logging.getLogger("uvicorn")




class ProviderError(RuntimeError):
    pass


_local_openai_client: Optional[openai.OpenAI] = None
_compat_openai_client: Optional[openai.OpenAI] = None
_gemini_request_window: deque[float] = deque()
_voice_generation_lock = Lock()
_alibaba_sdk_lock = Lock()
_voice_queue_state_lock = Lock()
_voice_queue_state: Dict[str, Any] = {
    "waiting": 0,
    "active": False,
    "last_error": "",
    "last_mode": "idle",
    "last_started_at": None,
    "last_finished_at": None,
    "last_node": "",
    "last_route": "",
    "last_language": "",
    "last_profile": "",
    "last_emotion": "",
    "last_style": "",
}
_voice_node_state_lock = Lock()
_voice_node_state: Dict[str, Dict[str, Any]] = {}


def reset_provider_clients() -> None:
    """Drop cached SDK clients after owner settings are changed at runtime."""
    global _local_openai_client, _compat_openai_client
    _local_openai_client = None
    _compat_openai_client = None


def _get_openai_client() -> openai.OpenAI:
    global _local_openai_client
    if _local_openai_client is None:
        _local_openai_client = openai.OpenAI(
            base_url=settings.local_openai_base,
            api_key=settings.local_openai_api_key,
        )
    return _local_openai_client


def _get_compat_openai_client() -> openai.OpenAI:
    global _compat_openai_client
    if _compat_openai_client is None:
        if not settings.openai_compat_api_key:
            raise ProviderError("LILY_OPENAI_COMPAT_API_KEY is not configured.")
        _compat_openai_client = openai.OpenAI(
            base_url=settings.openai_compat_base,
            api_key=settings.openai_compat_api_key,
            timeout=settings.openai_compat_timeout_seconds,
        )
    return _compat_openai_client


def _probe_http_service(url: str, timeout: float = 2.5, headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    try:
        response = requests.get(url, timeout=timeout, headers=headers)
        return {
            "reachable": True,
            "http_status": response.status_code,
            "ok": response.ok,
        }
    except Exception as error:
        return {
            "reachable": False,
            "ok": False,
            "error": str(error),
        }


def _fetch_http_json_service(url: str, timeout: float = 2.5, headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    try:
        response = requests.get(url, timeout=timeout, headers=headers)
        payload: Dict[str, Any] = {}
        try:
            payload = response.json()
        except ValueError:
            payload = {}

        return {
            "reachable": True,
            "http_status": response.status_code,
            "ok": response.ok,
            "data": payload,
        }
    except Exception as error:
        return {
            "reachable": False,
            "ok": False,
            "data": {},
            "error": str(error),
        }


def _voice_queue_snapshot() -> Dict[str, Any]:
    with _voice_queue_state_lock:
        return dict(_voice_queue_state)


def get_voice_queue_snapshot() -> Dict[str, Any]:
    snapshot = _voice_queue_snapshot()
    if snapshot.get("active"):
        state = "rendering"
    elif int(snapshot.get("waiting") or 0) > 0:
        state = "queued"
    elif snapshot.get("last_error"):
        state = "error"
    else:
        state = "idle"

    snapshot["state"] = state
    return snapshot


def _voice_queue_enter(mode: str) -> None:
    with _voice_queue_state_lock:
        _voice_queue_state["waiting"] += 1
        _voice_queue_state["last_mode"] = mode

    _voice_generation_lock.acquire()

    with _voice_queue_state_lock:
        _voice_queue_state["waiting"] = max(0, int(_voice_queue_state["waiting"]) - 1)
        _voice_queue_state["active"] = True
        _voice_queue_state["last_error"] = ""
        _voice_queue_state["last_mode"] = mode
        _voice_queue_state["last_started_at"] = time.time()


def _voice_queue_exit(error: str = "") -> None:
    with _voice_queue_state_lock:
        _voice_queue_state["active"] = False
        _voice_queue_state["last_error"] = error
        _voice_queue_state["last_finished_at"] = time.time()

    _voice_generation_lock.release()


def _voice_queue_note_request(
    route: str,
    language: str,
    profile: str,
    emotion: str,
    style: str,
) -> None:
    with _voice_queue_state_lock:
        _voice_queue_state["last_route"] = route
        _voice_queue_state["last_language"] = language
        _voice_queue_state["last_profile"] = profile
        _voice_queue_state["last_emotion"] = emotion
        _voice_queue_state["last_style"] = style


def _voice_node_headers(node: VoiceNodeConfig, *, json_content: bool = False) -> Dict[str, str]:
    headers: Dict[str, str] = {"Content-Type": "application/json"} if json_content else {}
    auth_value = node.token.get_secret_value()
    if auth_value:
        headers["X-Lily-Token"] = auth_value
    return headers


def _stream_voice_headers(*, json_content: bool = False) -> Dict[str, str]:
    headers: Dict[str, str] = {"Content-Type": "application/json"} if json_content else {}
    if settings.stream_voice_service_token:
        headers["X-Lily-Token"] = settings.stream_voice_service_token
    return headers


def _voice_node_runtime(node_id: str) -> Dict[str, Any]:
    with _voice_node_state_lock:
        return dict(_voice_node_state.get(node_id, {}))


def _voice_node_is_cooling(node: VoiceNodeConfig) -> bool:
    return float(_voice_node_runtime(node.id).get("cooldown_until") or 0.0) > time.time()


def _mark_voice_node_failure(node: VoiceNodeConfig, error: str) -> None:
    with _voice_node_state_lock:
        _voice_node_state[node.id] = {
            "cooldown_until": time.time() + node.cooldown_seconds,
            "last_error": error,
            "last_failure_at": time.time(),
        }


def _mark_voice_node_success(node: VoiceNodeConfig) -> None:
    with _voice_node_state_lock:
        _voice_node_state[node.id] = {
            "cooldown_until": 0.0,
            "last_error": "",
            "last_success_at": time.time(),
        }
    with _voice_queue_state_lock:
        _voice_queue_state["last_node"] = node.id


def _resolve_remote_audio_url(node: VoiceNodeConfig, value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw.startswith(("http://", "https://")):
        return raw
    parsed = urlparse(node.url)
    origin = f"{parsed.scheme}://{parsed.netloc}/"
    return urljoin(origin, raw.lstrip("/"))


def _resolve_service_audio_url(service_url: str, value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if parsed.scheme and parsed.netloc:
        return raw
    service = urlparse(service_url)
    origin = f"{service.scheme}://{service.netloc}/"
    return urljoin(origin, raw.lstrip("/"))


def _alibaba_language_type(language: str) -> str | None:
    return {
        "ja": "Japanese",
        "en": "English",
    }.get(str(language or "").strip().lower())


def _alibaba_generation_url() -> str:
    url = settings.alibaba_api_url.rstrip("/")
    if url.endswith("/generation"):
        return url
    return f"{url}/services/aigc/multimodal-generation/generation"


def _alibaba_websocket_url() -> str:
    workspace_id = settings.alibaba_workspace_id.strip()
    if settings.alibaba_region == "ap-southeast-1":
        region_host = "ap-southeast-1"
        shared_host = "dashscope-intl.aliyuncs.com"
    elif settings.alibaba_region == "cn-beijing":
        region_host = "cn-beijing"
        shared_host = "dashscope.aliyuncs.com"
    else:
        raise ProviderError("LILY_ALIBABA_REGION must be ap-southeast-1 or cn-beijing.")
    host = f"{workspace_id}.{region_host}.maas.aliyuncs.com" if workspace_id else shared_host
    return f"wss://{host}/api-ws/v1/inference"


def _generate_alibaba_qwen_audio_voice(
    text: str,
    language: str,
    voice_id: str,
) -> str:
    try:
        import dashscope
        from dashscope.audio.tts_v2 import SpeechSynthesizer
    except ImportError as error:
        raise ProviderError("Install the DashScope SDK from lily_essence_core/requirements.txt.") from error

    websocket_url = _alibaba_websocket_url()
    language_hint = language if language in {"id", "en", "ja"} else None
    synthesis_options: dict[str, Any] = {
        "model": settings.alibaba_model,
        "voice": voice_id,
        "instruction": settings.alibaba_instruction,
    }
    if language_hint:
        synthesis_options["language_hints"] = [language_hint]

    # DashScope keeps credentials and its endpoint in module globals; serialize this block.
    with _alibaba_sdk_lock:
        dashscope.api_key = settings.alibaba_api_key
        dashscope.base_websocket_api_url = websocket_url
        audio_bytes = SpeechSynthesizer(**synthesis_options).call(text)

    if not isinstance(audio_bytes, bytes) or not audio_bytes:
        raise ProviderError("Alibaba Qwen-Audio-TTS returned no audio data.")
    return save_audio_to_static(audio_bytes, f"alibaba_{uuid.uuid4().hex}.mp3")


def _generate_alibaba_voice(
    text: str,
    language: str,
    voice_profile: str,
) -> str | None:
    if not settings.alibaba_api_key:
        raise ProviderError("LILY_ALIBABA_API_KEY is not configured.")

    voice_id = settings.resolve_alibaba_voice_id(voice_profile)
    if not voice_id:
        raise ProviderError(
            "No Alibaba voice ID is configured. Set LILY_ALIBABA_VOICE_ID or LILY_ALIBABA_VOICE_MAP."
        )

    if settings.alibaba_model.startswith("qwen-audio-3.0-tts-"):
        return _generate_alibaba_qwen_audio_voice(text, language, voice_id)

    if language == "id" and settings.alibaba_model.startswith("qwen3-tts-vc"):
        raise ProviderError(
            "The configured Qwen3-TTS-VC model does not support Indonesian; use qwen-audio-3.0-tts-flash."
        )

    input_payload: dict[str, Any] = {
        "text": text,
        "voice": voice_id,
    }
    language_type = _alibaba_language_type(language)
    if language_type:
        input_payload["language_type"] = language_type

    response = requests.post(
        _alibaba_generation_url(),
        headers={
            "Authorization": f"Bearer {settings.alibaba_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": settings.alibaba_model,
            "input": input_payload,
        },
        timeout=settings.alibaba_timeout_seconds,
    )
    response.raise_for_status()
    payload = response.json()
    output = payload.get("output") if isinstance(payload, dict) else {}
    audio = output.get("audio") if isinstance(output, dict) else {}
    if not isinstance(audio, dict):
        audio = {}

    audio_url = str(audio.get("url") or "").strip()
    if audio_url:
        return audio_url

    encoded_audio = str(audio.get("data") or "").strip()
    if encoded_audio:
        try:
            audio_bytes = base64.b64decode(encoded_audio, validate=True)
        except (ValueError, TypeError) as error:
            raise ProviderError("Alibaba returned invalid base64 audio data.") from error
        return save_audio_to_static(audio_bytes, f"alibaba_{uuid.uuid4().hex}.mp3")

    raise ProviderError("Alibaba returned no audio URL or audio data.")


def resolve_effective_voice_route(route: str | None, language: str | None) -> str:
    selected = str(route or settings.voice_provider or "sovits").strip().lower()
    if settings.alibaba_indonesian_default and str(language or "").strip().lower() == "id" and selected == "sovits":
        return "alibaba"
    return selected


def _probe_voice_node(node: VoiceNodeConfig) -> Dict[str, Any]:
    runtime = _voice_node_runtime(node.id)
    cooldown_until = float(runtime.get("cooldown_until") or 0.0)
    if cooldown_until > time.time():
        return {
            "id": node.id,
            "status": "cooldown",
            "available": False,
            "priority": node.priority,
            "profiles": node.profiles,
            "cooldown_until": cooldown_until,
            "error": runtime.get("last_error"),
        }

    probe = _fetch_http_json_service(
        node.resolved_health_url(),
        timeout=max(0.2, float(settings.voice_service_health_timeout_seconds)),
        headers=_voice_node_headers(node),
    )
    payload = probe.get("data") or {}
    raw_status = str(payload.get("status") or "").strip().lower()
    status = raw_status if raw_status in {"ok", "online", "degraded", "offline", "busy"} else ""
    available = bool(probe.get("reachable") and probe.get("ok") and status not in {"offline", "busy"})
    return {
        "id": node.id,
        "status": status or ("online" if available else "offline"),
        "available": available,
        "priority": node.priority,
        "profiles": node.profiles,
        "detail": payload.get("detail"),
        "remote_queue": payload.get("queue") if isinstance(payload.get("queue"), dict) else {},
        "error": payload.get("error") or probe.get("error"),
    }


def _normalize_base_service_url(url: str) -> str:
    trimmed = url.rstrip("/")
    if trimmed.endswith("/v1"):
        return trimmed[:-3]
    return trimmed


def _call_claude_messages_api(content: list[dict[str, Any]], system_prompt: str) -> str:
    if not settings.claude_api_key:
        raise ProviderError("CLAUDE_API_KEY is not configured.")

    response = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": settings.claude_api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": settings.claude_model,
            "max_tokens": settings.claude_max_tokens,
            "system": system_prompt,
            "messages": [
                {
                    "role": "user",
                    "content": content,
                }
            ],
        },
        timeout=settings.claude_timeout_seconds,
    )
    response.raise_for_status()
    payload = response.json()
    parts = payload.get("content", [])
    text = " ".join(part.get("text", "").strip() for part in parts if part.get("type") == "text").strip()
    if not text:
        raise ProviderError("Claude returned an empty response.")
    return text


def _reserve_gemini_slot() -> bool:
    now = time.time()

    while _gemini_request_window and now - _gemini_request_window[0] >= 60:
        _gemini_request_window.popleft()

    if len(_gemini_request_window) >= settings.gemini_max_requests_per_minute:
        logger.warning(
            "[Lily Core] Gemini limiter active (%s/%s in the last minute).",
            len(_gemini_request_window),
            settings.gemini_max_requests_per_minute,
        )
        return False

    _gemini_request_window.append(now)
    return True


async def run_gemini_text(message: str, session: Dict[str, Any]) -> str:
    if not settings.gemini_api_key:
        raise ProviderError("GEMINI_API_KEY is not configured.")

    if not _reserve_gemini_slot():
        raise ProviderError("Gemini rate limit window is full.")

    try:
        import google.generativeai as genai
    except Exception as error:
        raise ProviderError(f"Gemini SDK import failed: {error}") from error

    try:
        genai.configure(api_key=settings.gemini_api_key)
        model = genai.GenerativeModel(settings.gemini_model)
        prompt = (
            f"{get_prompt('brain')}\n\n"
            f"Session: {session['session_id']}\n"
            f"Mode: {session['mode']}\n"
            f"Message: {message}"
        )
        response = model.generate_content(prompt)
        text = getattr(response, "text", "").strip()
        if not text:
            raise ProviderError("Gemini returned an empty response.")
        return text
    except Exception as error:
        raise ProviderError(f"Gemini provider failed: {error}") from error


def _extract_base64_image_payload(image_base64: str) -> tuple[str, str]:
    if image_base64.startswith("data:") and "," in image_base64:
        header, payload = image_base64.split(",", 1)
        media_type = "image/jpeg"
        if ";base64" in header:
            media_type = header[5:].split(";", 1)[0] or media_type
        return payload, media_type
    return image_base64, "image/jpeg"


async def run_local_brain(message: str, session: Dict[str, Any]) -> str:
    client = _get_openai_client()
    try:
        response = client.chat.completions.create(
            model=settings.local_brain_model,
            messages=[
                {"role": "system", "content": get_prompt("brain")},
                {
                    "role": "user",
                    "content": f"Session: {session['session_id']}\nMode: {session['mode']}\nMessage: {message}",
                },
            ],
            temperature=0.7,
            max_tokens=180,
        )
        return response.choices[0].message.content.strip()
    except Exception as error:
        raise ProviderError(f"Local brain provider failed: {error}") from error


async def run_openai_compat_brain(message: str, session: Dict[str, Any]) -> str:
    client = _get_compat_openai_client()
    try:
        extra_body = (
            {"thinking": {"type": settings.openai_compat_thinking_mode}}
            if settings.openai_compat_thinking_mode in {"enabled", "disabled"}
            else None
        )
        response = client.chat.completions.create(
            model=settings.openai_compat_brain_model,
            messages=[
                {"role": "system", "content": get_prompt("brain")},
                {
                    "role": "user",
                    "content": f"Session: {session['session_id']}\nMode: {session['mode']}\nMessage: {message}",
                },
            ],
            temperature=0.7,
            max_tokens=180,
            extra_body=extra_body,
        )
        text = (response.choices[0].message.content or "").strip()
        if not text:
            raise ProviderError("OpenAI-compatible brain returned an empty response.")
        return text
    except Exception as error:
        raise ProviderError(f"OpenAI-compatible brain provider failed: {error}") from error


async def run_claude_text(message: str, session: Dict[str, Any]) -> str:
    return _call_claude_messages_api(
        [{"type": "text", "text": f"Session: {session['session_id']}\nMode: {session['mode']}\nMessage: {message}"}],
        get_prompt("brain"),
    )


async def run_text_task(
    message: str,
    system_prompt: str,
    session: Dict[str, Any],
    *,
    max_tokens: int = 220,
    temperature: float = 0.0,
    provider_chain: Optional[list[str]] = None,
    request_timeout: float | None = None,
) -> str:
    tried: list[str] = []
    chain = provider_chain or settings.text_provider_chain

    for provider in chain:
        if not provider or provider in tried:
            continue
        tried.append(provider)
        try:
            if provider == "lmstudio":
                client = _get_openai_client()
                if request_timeout is not None:
                    client = client.with_options(timeout=min(1.5, request_timeout), max_retries=0)
                response = client.chat.completions.create(
                    model=settings.local_brain_model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": message},
                    ],
                    temperature=temperature,
                    max_tokens=max_tokens,
                )
                text = (response.choices[0].message.content or "").strip()
                if not text:
                    raise ProviderError("Local text task returned an empty response.")
                return text
            if provider == "openai_compat":
                client = _get_compat_openai_client()
                if request_timeout is not None:
                    client = client.with_options(timeout=request_timeout, max_retries=0)
                extra_body = (
                    {"thinking": {"type": settings.openai_compat_thinking_mode}}
                    if settings.openai_compat_thinking_mode in {"enabled", "disabled"}
                    else None
                )
                response = client.chat.completions.create(
                    model=settings.openai_compat_brain_model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": message},
                    ],
                    temperature=temperature,
                    max_tokens=max_tokens,
                    extra_body=extra_body,
                )
                text = (response.choices[0].message.content or "").strip()
                if not text:
                    raise ProviderError("OpenAI-compatible text task returned an empty response.")
                return text
            if provider == "claude":
                return _call_claude_messages_api([{"type": "text", "text": message}], system_prompt)
            if provider == "gemini":
                if not settings.gemini_api_key:
                    raise ProviderError("GEMINI_API_KEY is not configured.")
                if not _reserve_gemini_slot():
                    raise ProviderError("Gemini rate limit window is full.")
                try:
                    import google.generativeai as genai
                except Exception as error:
                    raise ProviderError(f"Gemini SDK import failed: {error}") from error
                genai.configure(api_key=settings.gemini_api_key)
                model = genai.GenerativeModel(settings.gemini_model)
                response = model.generate_content(f"{system_prompt}\n\n{message}")
                text = getattr(response, "text", "").strip()
                if not text:
                    raise ProviderError("Gemini text task returned an empty response.")
                return text
        except Exception as error:
            logger.warning("[Lily Core] Text task provider '%s' failed: %s", provider, error)

    raise ProviderError("No text task provider is available.")


async def run_brain(message: str, session: Dict[str, Any]) -> str:
    tried: list[str] = []

    for provider in settings.text_provider_chain:
        if not provider or provider in tried:
            continue
        tried.append(provider)
        try:
            if provider == "lmstudio":
                return await run_local_brain(message, session)
            if provider == "openai_compat":
                return await run_openai_compat_brain(message, session)
            if provider == "claude":
                return await run_claude_text(message, session)
            if provider == "gemini":
                return await run_gemini_text(message, session)
        except Exception as error:
            logger.warning("[Lily Core] Brain provider '%s' failed: %s", provider, error)

    raise ProviderError("No brain provider is available.")


async def run_claude_vision(image_base64: str, context_note: str, session: Dict[str, Any]) -> str:
    image_data, media_type = _extract_base64_image_payload(image_base64)
    try:
        base64.b64decode(image_data, validate=True)
    except Exception as error:
        raise ProviderError(f"Invalid base64 image payload: {error}") from error

    note_text = context_note.strip() or "general scene check"
    return _call_claude_messages_api(
        [
            {"type": "text", "text": f"Session: {session['session_id']}\nMode: {session['mode']}\nContext: {note_text}"},
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": image_data,
                },
            },
        ],
        get_prompt("vision"),
    )


async def _run_openai_compat_vision_request(
    image_base64: str,
    context_note: str,
    session: Dict[str, Any],
    *,
    base_url: str,
    api_key: str,
    model: str,
    timeout_seconds: int,
    label: str,
) -> str:
    if not api_key:
        raise ProviderError(f"{label} API key is not configured.")
    if not model:
        raise ProviderError(f"{label} model is not configured.")

    image_data, media_type = _extract_base64_image_payload(image_base64)
    try:
        base64.b64decode(image_data, validate=True)
    except Exception as error:
        raise ProviderError(f"Invalid base64 image payload: {error}") from error

    note_text = context_note.strip() or "general scene check"
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": get_prompt("vision"),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"Session: {session['session_id']}\nMode: {session['mode']}\nContext: {note_text}",
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{media_type};base64,{image_data}",
                        },
                    },
                ],
            },
        ],
        "max_tokens": settings.claude_max_tokens,
    }

    try:
        response = requests.post(
            f"{_normalize_base_service_url(base_url)}/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        data = response.json()
        final_text = str(((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        if not final_text:
            raise ProviderError(f"{label} returned an empty response.")
        return final_text
    except Exception as error:
        raise ProviderError(f"{label} failed: {error}") from error


async def run_openai_compat_vision(image_base64: str, context_note: str, session: Dict[str, Any]) -> str:
    return await _run_openai_compat_vision_request(
        image_base64,
        context_note,
        session,
        base_url=settings.openai_compat_base,
        api_key=settings.openai_compat_api_key,
        model=settings.openai_compat_vision_model,
        timeout_seconds=settings.openai_compat_timeout_seconds,
        label="OpenAI-compatible vision provider",
    )


def _stream_stage_openai_compat_vision_configured() -> bool:
    provider = settings.stream_stage_vision_provider or "openai_compat"
    return bool(
        provider == "openai_compat"
        and settings.stream_stage_vision_api_key
        and settings.stream_stage_vision_base
        and settings.stream_stage_vision_model
    )


async def run_stream_stage_openai_compat_vision(image_base64: str, context_note: str, session: Dict[str, Any]) -> str:
    return await _run_openai_compat_vision_request(
        image_base64,
        context_note,
        session,
        base_url=settings.stream_stage_vision_base,
        api_key=settings.stream_stage_vision_api_key,
        model=settings.stream_stage_vision_model,
        timeout_seconds=settings.stream_stage_vision_timeout_seconds,
        label="Stream Stage OpenAI-compatible vision provider",
    )


def _stream_stage_vision_attempt_chain() -> list[str]:
    raw_chain = settings.stream_stage_vision_fallback_chain or ["stream_stage_openai_compat", "claude"]
    chain: list[str] = []
    for provider in raw_chain:
        normalized = provider.strip().lower()
        if not normalized or normalized in chain:
            continue
        chain.append(normalized)

    if not chain:
        chain = ["stream_stage_openai_compat"]

    if not settings.stream_stage_vision_fallback_enabled:
        return [chain[0]]
    return chain


def _legacy_openai_compat_vision_skip_reason() -> str:
    model = settings.openai_compat_vision_model.strip().lower()
    text_only_models = {"deepseek-chat", "deepseek-reasoner"}
    if model in text_only_models or model.startswith("deepseek-coder"):
        return f"legacy_openai_compat skipped because model '{model}' looks text-only."
    return ""


async def _run_vision_provider(provider: str, image_base64: str, context_note: str, session: Dict[str, Any]) -> str:
    if provider == "stream_stage_openai_compat":
        stream_stage_provider = settings.stream_stage_vision_provider or "openai_compat"
        if stream_stage_provider != "openai_compat":
            raise ProviderError(f"Unsupported Stream Stage vision provider '{stream_stage_provider}'.")
        return await run_stream_stage_openai_compat_vision(image_base64, context_note, session)

    if provider == "claude":
        return await run_claude_vision(image_base64, context_note, session)

    if provider in {"legacy_openai_compat", "openai_compat"}:
        skip_reason = _legacy_openai_compat_vision_skip_reason()
        if skip_reason:
            raise ProviderError(skip_reason)
        return await run_openai_compat_vision(image_base64, context_note, session)

    raise ProviderError(f"Unsupported Stream Stage vision fallback provider '{provider}'.")


async def run_vision(image_base64: str, context_note: str, session: Dict[str, Any]) -> str:
    attempt_errors: list[str] = []
    for provider in _stream_stage_vision_attempt_chain():
        try:
            return await _run_vision_provider(provider, image_base64, context_note, session)
        except Exception as error:
            attempt_errors.append(f"{provider}: {error}")
            logger.warning("[Lily Core] Vision provider '%s' failed: %s", provider, error)

    detail = "; ".join(attempt_errors) if attempt_errors else "no providers configured"
    raise ProviderError(f"No Stream Stage vision provider succeeded. Attempts: {detail}")


async def generate_voice_result(
    text: str,
    emotion: str,
    style: str,
    language: Optional[str] = None,
    voice_profile: Optional[str] = None,
    voice_route: Optional[str] = None,
) -> Optional[str]:
    tts_text = sanitize_for_tts(text)
    if not tts_text:
        logger.info("[Lily Core] Voice skipped because text is empty after TTS sanitizer.")
        return None

    selected_language = (language or settings.voice_language).strip().lower()
    selected_profile = (voice_profile or settings.voice_profile).strip()
    normalized_voice_route = resolve_effective_voice_route(voice_route, selected_language)
    _voice_queue_note_request(
        normalized_voice_route,
        selected_language,
        selected_profile,
        emotion,
        style,
    )
    if normalized_voice_route in {"stream_stage", "stream_voice", "rvc"}:
        queue_error = ""
        _voice_queue_enter("stream_edge_rvc")
        try:
            if settings.stream_voice_provider != "edge_rvc":
                queue_error = f"Unsupported stream voice provider '{settings.stream_voice_provider}'."
                logger.warning("[Lily Core] %s", queue_error)
                return None
            if not settings.stream_voice_service_url:
                queue_error = "LILY_STREAM_VOICE_SERVICE_URL is not configured."
                logger.warning("[Lily Core] %s", queue_error)
                return None

            def _request_stream_voice() -> requests.Response:
                return requests.post(
                    settings.stream_voice_service_url,
                    headers=_stream_voice_headers(json_content=True),
                    json={
                        "text": tts_text,
                        "emotion": emotion,
                        "style": style,
                        "voice_language": selected_language or None,
                        "voice_profile": selected_profile or None,
                        "tts_provider": settings.stream_voice_tts_mode,
                    },
                    timeout=settings.stream_voice_service_timeout_seconds,
                )

            try:
                response = await asyncio.to_thread(_request_stream_voice)
                response.raise_for_status()
                data = response.json()
                audio_url = _resolve_service_audio_url(
                    settings.stream_voice_service_url,
                    data.get("audio_url") or data.get("audio"),
                )
                if not audio_url:
                    queue_error = "Stream voice vessel returned no audio URL."
                    logger.warning("[Lily Core] %s", queue_error)
                    return None
                with _voice_queue_state_lock:
                    _voice_queue_state["last_provider"] = str(data.get("provider") or "")
                    _voice_queue_state["last_tts_provider"] = str(data.get("tts_provider") or "")
                    _voice_queue_state["last_fallback_used"] = bool(data.get("fallback_used"))
                return audio_url
            except Exception as error:
                queue_error = str(error)
                logger.warning("[Lily Core] Strict stream voice route '%s' failed: %s", normalized_voice_route, error)
                return None
        finally:
            _voice_queue_exit(queue_error)

    if normalized_voice_route == "alibaba":
        queue_error = ""
        _voice_queue_enter("alibaba")
        try:
            try:
                audio_url = await asyncio.to_thread(
                    _generate_alibaba_voice,
                    tts_text,
                    selected_language,
                    selected_profile,
                )
                with _voice_queue_state_lock:
                    _voice_queue_state["last_provider"] = settings.alibaba_model
                return sign_core_audio_url(audio_url)
            except Exception as error:
                queue_error = str(error)
                logger.warning("[Lily Core] Alibaba voice route failed: %s", error)
                return None
        finally:
            _voice_queue_exit(queue_error)

    strict_registry_route = normalized_voice_route == "sovits2"
    voice_nodes = [
        node
        for node in settings.voice_nodes
        if (not strict_registry_route or node.id == "sovits2")
        and node.supports(selected_language, selected_profile)
    ]
    queue_mode = "registry:sovits2" if strict_registry_route else ("registry" if voice_nodes else "local")
    queue_error = ""

    _voice_queue_enter(queue_mode)
    try:
        if strict_registry_route and not voice_nodes:
            queue_error = "SoVITS 2 registry node 'sovits2' is not configured for this language/profile."
            logger.warning("[Lily Core] %s", queue_error)
            return None

        for node in voice_nodes:
            if _voice_node_is_cooling(node):
                continue
            health = _probe_voice_node(node)
            if not health.get("available"):
                error = str(health.get("error") or health.get("detail") or health.get("status") or "unavailable")
                _mark_voice_node_failure(node, error)
                queue_error = f"{node.id}: {error}"
                continue
            try:
                response = requests.post(
                    node.url,
                    headers=_voice_node_headers(node, json_content=True),
                    json={
                        "text": tts_text,
                        "emotion": emotion,
                        "style": style,
                        "voice_language": selected_language,
                        "voice_profile": selected_profile,
                    },
                    timeout=node.timeout_seconds,
                )
                response.raise_for_status()
                data = response.json()
                audio_url = _resolve_remote_audio_url(node, data.get("audio_url") or data.get("audio"))
                if audio_url:
                    _mark_voice_node_success(node)
                    queue_error = ""
                    return audio_url

                queue_error = f"{node.id}: remote voice provider returned no audio URL."
                _mark_voice_node_failure(node, queue_error)
                logger.warning("[Lily Core] Voice node '%s' returned no audio URL.", node.id)
            except Exception as error:
                queue_error = f"{node.id}: {error}"
                _mark_voice_node_failure(node, str(error))
                logger.warning("[Lily Core] Voice node '%s' failed: %s", node.id, error)

        if strict_registry_route:
            return None

        try:
            audio_url = generate_voice(
                tts_text,
                emotion=emotion,
                language=selected_language,
                voice_profile=selected_profile or None,
            )
            queue_error = "" if audio_url else queue_error
            return sign_core_audio_url(audio_url)
        except Exception as error:
            queue_error = str(error)
            logger.warning("[Lily Core] Local voice provider failed: %s", error)
            return None
    finally:
        _voice_queue_exit(queue_error)


def get_brain_health() -> Dict[str, Any]:
    configured_provider = settings.brain_provider
    fallback_provider = settings.text_fallback_provider
    provider_chain = settings.text_provider_chain or [configured_provider]

    def _health_for_provider(name: str) -> Dict[str, Any]:
        if name == "lmstudio":
            models_url = f"{_normalize_base_service_url(settings.local_openai_base)}/v1/models"
            probe = _probe_http_service(models_url)
            return {
                "status": "online" if probe["reachable"] and probe["ok"] else "offline",
                "provider": name,
                "detail": "LM Studio local brain is reachable." if probe["reachable"] and probe["ok"] else "LM Studio local brain is unavailable.",
                "model": settings.local_brain_model,
                "error": probe.get("error"),
            }

        if name == "openai_compat":
            models_url = f"{_normalize_base_service_url(settings.openai_compat_base)}/v1/models"
            probe = _probe_http_service(
                models_url,
                timeout=float(settings.openai_compat_timeout_seconds),
                headers={"Authorization": f"Bearer {settings.openai_compat_api_key}"} if settings.openai_compat_api_key else None,
            )
            return {
                "status": "online" if probe["reachable"] and probe["ok"] and bool(settings.openai_compat_api_key) else "offline",
                "provider": name,
                "detail": "OpenAI-compatible brain endpoint is reachable." if probe["reachable"] and probe["ok"] and bool(settings.openai_compat_api_key) else "OpenAI-compatible brain endpoint is unavailable or missing API key.",
                "model": settings.openai_compat_brain_model,
                "error": probe.get("error"),
            }

        if name == "claude":
            return {
                "status": "online" if settings.claude_api_key else "offline",
                "provider": name,
                "detail": "Claude text brain is configured." if settings.claude_api_key else "CLAUDE_API_KEY is missing.",
                "model": settings.claude_model,
            }

        if name == "gemini":
            return {
                "status": "online" if settings.gemini_api_key else "offline",
                "provider": name,
                "detail": "Gemini text brain is configured." if settings.gemini_api_key else "GEMINI_API_KEY is missing.",
                "model": settings.gemini_model,
            }

        return {
            "status": "offline",
            "provider": name,
            "detail": f"Unsupported brain provider '{name}'.",
        }

    attempts = [_health_for_provider(name) for name in provider_chain if name]
    primary = attempts[0] if attempts else _health_for_provider(configured_provider)
    online_attempt = next((attempt for attempt in attempts if attempt.get("status") == "online"), None)

    payload = {
        "status": "online" if primary.get("status") == "online" else "degraded" if online_attempt else "offline",
        "provider": online_attempt["provider"] if online_attempt else primary["provider"],
        "fallback_provider": fallback_provider,
        "provider_chain": provider_chain,
        "detail": primary["detail"] if primary.get("status") == "online" else (
            f"{primary['provider']} is unavailable. Using {online_attempt['provider']} from the text provider chain."
            if online_attempt
            else "No configured text brain provider is ready."
        ),
        "attempts": attempts,
    }
    if configured_provider != payload["provider"]:
        payload["configured_provider"] = configured_provider
    if primary.get("error"):
        payload["error"] = primary.get("error")
    if online_attempt and online_attempt.get("model"):
        payload["model"] = online_attempt.get("model")
    return payload


def _vision_provider_health(provider: str) -> Dict[str, Any]:
    if provider == "stream_stage_openai_compat":
        if settings.stream_stage_vision_provider and settings.stream_stage_vision_provider != "openai_compat":
            return {
                "status": "offline",
                "provider": provider,
                "detail": f"Unsupported Stream Stage vision provider '{settings.stream_stage_vision_provider}'.",
                "model": settings.stream_stage_vision_model,
            }
        if not _stream_stage_openai_compat_vision_configured():
            return {
                "status": "offline",
                "provider": provider,
                "detail": "Stream Stage vision endpoint is missing API key, base URL, or model.",
                "model": settings.stream_stage_vision_model,
            }

        probe = _probe_http_service(
            f"{_normalize_base_service_url(settings.stream_stage_vision_base)}/v1/models",
            timeout=float(settings.stream_stage_vision_timeout_seconds),
            headers={"Authorization": f"Bearer {settings.stream_stage_vision_api_key}"},
        )
        return {
            "status": "online" if probe["reachable"] and probe["ok"] else "offline",
            "provider": provider,
            "detail": "Stream Stage vision endpoint is reachable." if probe["reachable"] and probe["ok"] else "Stream Stage vision endpoint is unavailable.",
            "model": settings.stream_stage_vision_model,
            "error": probe.get("error"),
        }

    if provider == "claude":
        return {
            "status": "online" if settings.claude_api_key else "offline",
            "provider": provider,
            "detail": "Claude Vision is configured." if settings.claude_api_key else "CLAUDE_API_KEY is missing.",
            "model": settings.claude_model,
        }

    if provider in {"legacy_openai_compat", "openai_compat"}:
        skip_reason = _legacy_openai_compat_vision_skip_reason()
        if skip_reason:
            return {
                "status": "skipped",
                "provider": provider,
                "detail": skip_reason,
                "model": settings.openai_compat_vision_model,
            }

        probe = _probe_http_service(
            f"{_normalize_base_service_url(settings.openai_compat_base)}/v1/models",
            timeout=float(settings.openai_compat_timeout_seconds),
            headers={"Authorization": f"Bearer {settings.openai_compat_api_key}"} if settings.openai_compat_api_key else None,
        )
        return {
            "status": "online" if probe["reachable"] and probe["ok"] and bool(settings.openai_compat_api_key) else "offline",
            "provider": provider,
            "detail": "Legacy OpenAI-compatible vision endpoint is reachable." if probe["reachable"] and probe["ok"] and bool(settings.openai_compat_api_key) else "Legacy OpenAI-compatible vision endpoint is unavailable or missing API key.",
            "model": settings.openai_compat_vision_model,
            "error": probe.get("error"),
        }

    return {
        "status": "offline",
        "provider": provider,
        "detail": f"Unsupported Stream Stage vision fallback provider '{provider}'.",
    }


def get_vision_health() -> Dict[str, Any]:
    chain = _stream_stage_vision_attempt_chain()
    attempts = [_vision_provider_health(provider) for provider in chain]
    first_online = next((attempt for attempt in attempts if attempt.get("status") == "online"), None)
    primary = attempts[0] if attempts else {"provider": None, "detail": "No Stream Stage vision providers configured."}

    if primary.get("status") == "online":
        status = "online"
    elif first_online:
        status = "degraded"
    else:
        status = "offline"

    detail = str((first_online or primary).get("detail") or "").strip()
    if not detail:
        detail = "Stream Stage vision fallback chain is configured."

    return {
        "status": status,
        "provider": primary.get("provider"),
        "primary_provider": chain[0] if chain else None,
        "fallback_enabled": settings.stream_stage_vision_fallback_enabled,
        "fallback_chain": chain,
        "scope": "stream_stage",
        "detail": detail,
        "model": primary.get("model"),
        "attempts": attempts,
    }


def _get_local_voice_health(core_queue: Dict[str, Any]) -> Dict[str, Any]:
    ref_data = get_voice_profile(settings.voice_profile or None, settings.voice_language, "normal")
    endpoint_url = ref_data.get("api_url", "").rstrip("/")
    gpt_model_configured = bool(ref_data.get("gpt_model_path"))
    sovits_model_configured = bool(ref_data.get("sovits_model_path"))
    model_switch_enabled = gpt_model_configured and sovits_model_configured
    model_switch_ready = model_switch_enabled or not (gpt_model_configured or sovits_model_configured)
    ref_audio_exists = bool(ref_data.get("audio")) and os.path.exists(ref_data["audio"])
    probe = _probe_http_service(endpoint_url)

    if not model_switch_ready:
        status = "degraded"
        detail = "Voice profile checkpoint config is incomplete. Set both GPT and SoVITS model paths, or leave both empty."
    elif probe["reachable"] and ref_audio_exists:
        status = "online"
        detail = "SoVITS endpoint, reference voice, and profile routing are ready."
    elif probe["reachable"] or ref_audio_exists:
        status = "degraded"
        detail = "Voice stack is partially ready. Check SoVITS endpoint or reference audio."
    else:
        status = "offline"
        detail = "SoVITS endpoint and reference voice are unavailable."

    return {
        "status": status,
        "provider": settings.voice_provider,
        "mode": "local",
        "detail": detail,
        "endpoint": endpoint_url,
        "voice_language": ref_data["language"],
        "voice_profile": ref_data["profile"],
        "reference_ready": ref_audio_exists,
        "model_switch_enabled": model_switch_enabled,
        "model_switch_ready": model_switch_ready,
        "gpt_model_configured": gpt_model_configured,
        "sovits_model_configured": sovits_model_configured,
        "endpoint_reachable": probe["reachable"],
        "queue": core_queue,
        "error": probe.get("error"),
    }


def _get_alibaba_voice_health(core_queue: Dict[str, Any]) -> Dict[str, Any]:
    voice_id_configured = bool(settings.alibaba_voice_id or settings.alibaba_voice_map)
    qwen_audio_model = settings.alibaba_model.startswith("qwen-audio-3.0-tts-")
    workspace_configured = bool(settings.alibaba_workspace_id)
    region_configured = settings.alibaba_region in {"ap-southeast-1", "cn-beijing"}
    configured = bool(
        settings.alibaba_api_key
        and voice_id_configured
        and (not qwen_audio_model or region_configured)
    )
    if configured:
        detail = "Alibaba Qwen voice route is configured."
        status = "ready"
    elif not settings.alibaba_api_key:
        detail = "LILY_ALIBABA_API_KEY is missing."
        status = "offline"
    elif qwen_audio_model and not region_configured:
        detail = "LILY_ALIBABA_REGION must be ap-southeast-1 or cn-beijing."
        status = "offline"
    else:
        detail = "Alibaba voice ID is missing. Set LILY_ALIBABA_VOICE_ID or LILY_ALIBABA_VOICE_MAP."
        status = "offline"
    return {
        "status": status,
        "provider": settings.voice_provider,
        "mode": "alibaba",
        "detail": detail,
        "model": settings.alibaba_model,
        "transport": "websocket" if qwen_audio_model else "http",
        "endpoint": ("workspace WebSocket" if workspace_configured else "regional WebSocket") if qwen_audio_model else _alibaba_generation_url(),
        "voice_id_configured": voice_id_configured,
        "workspace_configured": workspace_configured if qwen_audio_model else None,
        "region_configured": region_configured if qwen_audio_model else None,
        "queue": core_queue,
    }


def get_voice_health() -> Dict[str, Any]:
    core_queue = get_voice_queue_snapshot()
    if settings.voice_provider == "alibaba":
        return _get_alibaba_voice_health(core_queue)
    if settings.voice_provider == "rvc":
        return get_stream_voice_health()

    nodes: list[VoiceNodeConfig] = list(settings.voice_nodes)
    if not nodes:
        return _get_local_voice_health(core_queue)

    attempts = [_probe_voice_node(node) for node in nodes]
    first_available = next((attempt for attempt in attempts if attempt.get("available")), None)
    primary = attempts[0]

    if first_available:
        status = "online" if first_available is primary else "degraded"
        detail = str(first_available.get("detail") or "").strip()
        if not detail:
            detail = f"Voice node {first_available['id']} is ready."
        return {
            "status": status,
            "provider": settings.voice_provider,
            "mode": "registry",
            "detail": detail,
            "active_node": first_available["id"],
            "primary_node": primary["id"],
            "queue": core_queue,
            "remote_queue": first_available.get("remote_queue") or {},
            "nodes": attempts,
        }

    local_health = _get_local_voice_health(core_queue)
    local_status = str(local_health.get("status") or "offline")
    return {
        "status": "degraded" if local_status in {"online", "degraded"} else "offline",
        "provider": settings.voice_provider,
        "mode": "registry",
        "detail": (
            "All remote voice nodes are unavailable; local SoVITS is the active fallback."
            if local_status in {"online", "degraded"}
            else "No remote voice node or local SoVITS provider is ready."
        ),
        "active_node": "local" if local_status in {"online", "degraded"} else None,
        "primary_node": primary["id"],
        "queue": core_queue,
        "nodes": attempts,
        "local_fallback": local_health,
    }


def get_stream_voice_health() -> Dict[str, Any]:
    queue = get_voice_queue_snapshot()
    provider = settings.stream_voice_provider
    if provider != "edge_rvc":
        return {
            "status": "offline",
            "provider": provider,
            "mode": "strict",
            "scope": "stream_stage",
            "detail": f"Unsupported Stream Stage voice provider '{provider}'.",
            "queue": queue,
        }

    if not settings.stream_voice_service_health_url:
        return {
            "status": "offline",
            "provider": provider,
            "mode": "strict",
            "scope": "stream_stage",
            "detail": "Stream voice health URL is not configured.",
            "queue": queue,
        }

    probe = _fetch_http_json_service(
        settings.stream_voice_service_health_url,
        timeout=settings.stream_voice_service_health_timeout_seconds,
        headers=_stream_voice_headers(),
    )
    remote = probe.get("data") if isinstance(probe.get("data"), dict) else {}
    remote_status = str(remote.get("status") or "offline").strip().lower()
    online = bool(probe.get("ok") and remote_status == "online")
    detail = str(remote.get("detail") or "").strip()
    if not detail:
        detail = "Stream TTS/RVC voice is ready." if online else "Stream voice vessel is unavailable."
    return {
        "status": "online" if online else "offline",
        "provider": provider,
        "mode": "strict",
        "scope": "stream_stage",
        "detail": detail,
        "endpoint_reachable": bool(probe.get("reachable")),
        "queue": queue,
        "remote_queue": remote.get("queue") or {},
        "model": remote.get("model") or {},
        "index": remote.get("index") or {},
        "cuda": remote.get("cuda") or {},
        "cache": remote.get("cache") or {},
        "tts": remote.get("tts") or {"mode": settings.stream_voice_tts_mode},
        "error": probe.get("error") or remote.get("last_error") or None,
    }
