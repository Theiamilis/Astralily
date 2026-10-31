"""Device request orchestration; owns inventory cache and clarification flow."""
import asyncio
import json
import logging
import time
from typing import Dict

from .expression_directives import infer_emotion, infer_expression, split_expression_directive
from .home_control import (
    HomeCommand,
    HomeCommandNotForHome,
    HomeControlError,
    create_home_client,
    execute_home_command,
    execute_home_plan,
    format_home_result,
    home_planner_enabled,
    home_planner_min_confidence,
    home_planner_timeout_seconds,
    is_home_planning_candidate,
    plan_home_ambience,
    parse_home_command,
    preview_home_command,
    preview_home_plan,
    recent_home_context,
    resolve_home_devices,
    sanitize_home_state,
    select_home_context_targets,
)
from .settings import settings
from .power import (
    DevicePowerError,
    WakePowerError,
    execute_device_power,
    execute_wake_power,
    execute_target_wake_power,
    get_device_power_history,
    get_device_power_status,
    is_wake_power_message,
    resolve_device_power_intent,
)
from .providers import ProviderError, run_text_task
from .device_intent import DeviceDecision, recent_device_dialogue, understand_device_request
from .device_language import device_text, power_action_label
from .power import list_device_power_targets
from .schemas import CoreResult, IngestRequest


from .response_support import (
    _expression_source_metadata,
    _resolve_voice_route,
    _resolve_voice_backend_route,
    _resolve_reply_language,
    _reply_language_label,
    _normalize_realm_reply_language,
    _generate_audio_from_final_reply,
    _normalize_voice_output_language,
    _prepare_voice_output,
    _resolve_expression_profile,
    _resolve_expression_options,
)


logger = logging.getLogger("lily.core.handlers")





_device_inventory_cache: dict[str, object] = {}


async def _device_inventory() -> tuple[list[dict], list[dict]]:
    try:
        power_targets = list_device_power_targets()
    except DevicePowerError:
        power_targets = []
    key = (settings.home_vessel_url, settings.home_vessel_token)
    cached = _device_inventory_cache
    if cached.get("key") == key and time.monotonic() < float(cached.get("expires", 0)):
        return cached["lights"], power_targets
    try:
        lights = await asyncio.to_thread(create_home_client().list_devices)
    except HomeControlError:
        lights = []
    _device_inventory_cache.update(key=key, lights=lights, expires=time.monotonic() + (30 if lights else 5))
    return lights, power_targets


async def _maybe_handle_device_request(req: IngestRequest, message: str, session: Dict[str, object]) -> CoreResult | None:
    # Explicit power confirmation remains deterministic and cannot be synthesized
    # by a language model. Attachment/tool requests retain their existing route.
    if message.strip().lower().startswith("/power"):
        return await _maybe_handle_device_power_request(req, message)
    if req.payload.get("input_files") or req.mode == "owner_tool":
        return None
    raw_context = req.payload.get("context")
    context = raw_context if isinstance(raw_context, dict) else {}
    language = _normalize_realm_reply_language(context.get("language")) or _resolve_reply_language(req.payload, message)
    lights, power_targets = await _device_inventory()
    decision = await understand_device_request(
        message, lights, power_targets, session, run_text_task,
        home_context=recent_home_context(session, settings.home_context_ttl_seconds),
        language=language, min_confidence=max(.75, settings.intent_router_min_confidence),
    )
    if decision.intent == "chat":
        session.pop("device_dialogue", None)
        return None
    if decision.intent in {"clarify", "no_action"}:
        if decision.intent == "clarify":
            default_reply = device_text(language, "clarify")
            previous = recent_device_dialogue(session)
            if not previous.get("question"):
                previous = {}
            session["device_dialogue"] = {
                "request": (str(previous.get("request", "")) + "\n" + message).strip()[-1200:],
                "question": decision.reply or default_reply, "updated_at": time.time(),
            }
        else:
            session.pop("device_dialogue", None)
            default_reply = device_text(language, "no_action")
        text = (decision.reply or default_reply) if decision.intent == "clarify" else default_reply
        return CoreResult(
            session_id=req.session_id, trace_id=req.trace_id, reply_target=req.source,
            text=text, subtitle=text, emotion="neutral", expression=infer_expression("neutral"),
            metadata={"source": req.source, "audio_target": req.source,
                      "device_intent": decision.intent, "device_intent_confidence": decision.confidence,
                      "device_action_executed": False},
        )
    if decision.intent == "wake_pc":
        result = await _maybe_handle_wake_request(req, message, session, understood=True)
    elif decision.intent == "power" and decision.power_action == "wake":
        result = await _maybe_handle_wake_request(
            req, message, session, understood=True, target_id=decision.targets[0],
        )
    elif decision.intent == "power":
        result = await _maybe_handle_device_power_request(
            req, f"/power {decision.power_action} {decision.targets[0]}",
        )
    else:
        previous = recent_device_dialogue(session)
        resolved_message = message
        if previous.get("question"):
            resolved_message = f"Previous request: {previous.get('request', '')}\nClarification: {previous['question']}\nOwner answer: {message}"
        result = await _maybe_handle_home_request(req, resolved_message, session, decision=decision)
    session["device_dialogue"] = {
        "request": message, "intent": decision.intent, "targets": decision.targets,
        "updated_at": time.time(),
    }
    if result is not None:
        result.metadata.update(device_intent=decision.intent, device_intent_confidence=decision.confidence)
    return result


async def _maybe_handle_wake_request(
    req: IngestRequest,
    message: str,
    session: Dict[str, object],
    *,
    understood: bool = False,
    target_id: str = "",
) -> CoreResult | None:
    if not understood and not is_wake_power_message(message):
        return None

    source = req.source
    reason = f"{source} owner request: {message}"
    raw_context = req.payload.get("context")
    context = dict(raw_context) if isinstance(raw_context, dict) else {}
    expression_profile = _resolve_expression_profile(source, context)
    expression_options = _resolve_expression_options(context)
    reply_language = _normalize_realm_reply_language(context.get("language")) or _resolve_reply_language(req.payload, message)
    text = device_text(reply_language, "wake")
    text, expression_from_directive = split_expression_directive(text, expression_profile, expression_options)
    emotion = infer_emotion(text)
    expression = expression_from_directive or infer_expression(emotion, expression_profile, expression_options)
    want_voice = bool(req.payload.get("want_voice", False))
    voice_language, voice_profile = _resolve_voice_route(context)
    voice_route = _resolve_voice_backend_route(context)
    voice_text, voice_romanji, voice_translation_error = await _prepare_voice_output(
        text,
        context,
        session,
        enabled=want_voice,
    )
    audio_url, tts_text = await _generate_audio_from_final_reply(
        voice_text,
        emotion,
        "owner_chat",
        want_voice,
        voice_language,
        voice_profile,
        voice_route=voice_route,
    )

    try:
        if target_id:
            wake_result = await asyncio.to_thread(execute_target_wake_power, target_id, source, reason)
        else:
            wake_result = await asyncio.to_thread(execute_wake_power, source, reason, False)
    except WakePowerError as error:
        text = device_text(reply_language, "wake_error", detail=error.detail)
        return CoreResult(
            ok=False,
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=source,
            text=text,
            subtitle=text,
            emotion="neutral",
            metadata={
                "source": source,
                "audio_target": source,
                "user_message": message,
                "mode": req.mode,
                "tool": "wake_power",
                "wake_status": "failed",
                "wake_error": error.detail,
                "wake_target": target_id,
            },
        )

    return CoreResult(
        session_id=req.session_id,
        trace_id=req.trace_id,
        reply_target=source,
        text=text,
        subtitle=text,
        emotion=emotion,
        expression=expression,
        audio_url=audio_url,
        metadata={
            "source": source,
            "audio_target": source,
            "user_message": message,
            "mode": req.mode,
            "tool": "wake_power",
            "wake_status": "ok",
            "wake_result": wake_result,
            "wake_target": target_id,
            "wake_execution_timing": "after_voice_ready" if want_voice else "immediate",
            "voice_language": voice_language,
            "voice_profile": voice_profile,
            "voice_text": voice_text,
            "voice_romanji": voice_romanji,
            "voice_translation_error": voice_translation_error,
            "voice_output_language": _normalize_voice_output_language(
                context.get("voice_output_language") or voice_language
            ),
            "tts_text": tts_text,
            "tts_sanitized": True,
            "expression_source": _expression_source_metadata(expression_from_directive),
            "expression_profile": expression_profile,
        },
    )


async def _maybe_handle_device_power_request(req: IngestRequest, message: str) -> CoreResult | None:
    intent = resolve_device_power_intent(req.session_id, message)
    if not intent:
        return None

    kind = str(intent.get("kind") or "")
    target = intent.get("target") if isinstance(intent.get("target"), dict) else {}
    target_id = str(target.get("id") or "")
    target_label = str(target.get("label") or target_id or "that device")
    action = str(intent.get("action") or "")
    context = req.payload.get("context")
    context = context if isinstance(context, dict) else {}
    language = _normalize_realm_reply_language(context.get("language")) or _resolve_reply_language(req.payload, message)
    action_label = power_action_label(action, language)
    metadata = {
        "source": req.source,
        "audio_target": req.source,
        "user_message": message,
        "mode": req.mode,
        "tool": "device_power",
        "power_status": kind,
        "power_target": target_id,
        "power_action": action,
        "power_request_id": intent.get("id"),
    }

    if kind == "help":
        text = device_text(language, "power_help")
        return CoreResult(
            ok=False,
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source,
            text=text,
            subtitle=text,
            emotion="neutral",
            metadata=metadata,
        )

    if kind == "unknown_target":
        requested_target = str(intent.get("requested_target") or "").strip()
        text = device_text(language, "unknown_target", target=requested_target)
        return CoreResult(
            ok=False,
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source,
            text=text,
            subtitle=text,
            emotion="neutral",
            metadata=metadata,
        )

    if kind == "no_pending":
        text = device_text(language, "no_pending")
        return CoreResult(
            ok=False,
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source,
            text=text,
            subtitle=text,
            emotion="neutral",
            metadata=metadata,
        )

    if kind == "invalid_confirmation":
        text = device_text(language, "invalid_confirmation")
        return CoreResult(
            ok=False,
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source,
            text=text,
            subtitle=text,
            emotion="neutral",
            metadata=metadata,
        )

    if kind == "pending":
        confirmation_code = str(intent.get("confirmation_code") or "")
        text = device_text(language, "pending", action=action_label, target=target_label, code=confirmation_code)
        return CoreResult(
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source,
            text=text,
            subtitle=text,
            emotion="neutral",
            metadata=metadata,
        )

    if kind == "denied":
        text = device_text(language, "denied", action=action_label, target=target_label)
        return CoreResult(
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source,
            text=text,
            subtitle=text,
            emotion="neutral",
            metadata=metadata,
        )

    if kind == "unavailable":
        text = device_text(language, "unavailable", target=target_label)
        return CoreResult(
            ok=False,
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source,
            text=text,
            subtitle=text,
            emotion="neutral",
            metadata=metadata,
        )

    if kind == "status":
        try:
            result = await asyncio.to_thread(get_device_power_status, target_id)
        except DevicePowerError as error:
            text = device_text(language, "status_error", target=target_label, detail=error.detail)
            return CoreResult(
                ok=False,
                session_id=req.session_id,
                trace_id=req.trace_id,
                reply_target=req.source,
                text=text,
                subtitle=text,
                emotion="worried",
                metadata={**metadata, "power_status": "failed", "power_error": error.detail},
            )
        devices = result.get("devices") if isinstance(result.get("devices"), list) else []
        status = devices[0] if devices and isinstance(devices[0], dict) else {}
        if not status.get("online"):
            text = device_text(language, "offline", target=target_label)
        else:
            uptime_seconds = max(0, int(status.get("uptime_seconds") or 0))
            uptime_hours, remainder = divmod(uptime_seconds, 3600)
            uptime_minutes = remainder // 60
            cpu = round(float(status.get("cpu_percent") or 0))
            used_gb = float(status.get("memory_used_bytes") or 0) / (1024 ** 3)
            total_gb = float(status.get("memory_total_bytes") or 0) / (1024 ** 3)
            user = str(status.get("logged_in_user") or "no interactive user")
            text = device_text(language, "status", target=target_label, hours=uptime_hours,
                               minutes=uptime_minutes, cpu=cpu, used=used_gb, total=total_gb, user=user)
        return CoreResult(
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source,
            text=text,
            subtitle=text,
            emotion="neutral",
            metadata={**metadata, "power_status": "status", "power_result": result},
        )

    if kind == "history":
        try:
            result = await asyncio.to_thread(get_device_power_history, target_id, 8)
        except DevicePowerError as error:
            text = device_text(language, "history_error", detail=error.detail)
            return CoreResult(
                ok=False,
                session_id=req.session_id,
                trace_id=req.trace_id,
                reply_target=req.source,
                text=text,
                subtitle=text,
                emotion="worried",
                metadata={**metadata, "power_status": "failed", "power_error": error.detail},
            )
        items = result.get("items") if isinstance(result.get("items"), list) else []
        if not items:
            text = device_text(language, "history_empty", target=target_label)
        else:
            rows = []
            for item in items[:6]:
                if not isinstance(item, dict):
                    continue
                timestamp = str(item.get("timestamp") or "").replace("T", " ")[:16]
                label = str(item.get("target_label") or item.get("target") or "device")
                action_label = str(item.get("state") or item.get("action") or item.get("event") or "event")
                result_label = "ok" if item.get("ok") is True else ("failed" if item.get("ok") is False else "recorded")
                rows.append(f"- {timestamp} UTC | {label} | {action_label} | {result_label}")
            text = device_text(language, "history") + "\n" + "\n".join(rows)
        return CoreResult(
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source,
            text=text,
            subtitle=text,
            emotion="neutral",
            metadata={**metadata, "power_status": "history", "power_result": result},
        )

    try:
        result = await asyncio.to_thread(
            execute_device_power,
            target_id,
            action,
            req.source,
            f"Owner-confirmed request: {message}",
        )
    except DevicePowerError as error:
        text = device_text(language, "power_error", action=action_label, target=target_label, detail=error.detail)
        return CoreResult(
            ok=False,
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source,
            text=text,
            subtitle=text,
            emotion="worried",
            metadata={**metadata, "power_status": "failed", "power_error": error.detail},
        )

    if action in {"shutdown", "restart"}:
        text = device_text(language, "power_delayed", action=action_label, target=target_label)
    elif action == "hibernate":
        text = device_text(language, "hibernate", target=target_label)
    else:
        text = device_text(language, "abort", target=target_label)
    return CoreResult(
        session_id=req.session_id,
        trace_id=req.trace_id,
        reply_target=req.source,
        text=text,
        subtitle=text,
        emotion="neutral",
        metadata={**metadata, "power_status": "completed", "power_result": result},
    )


async def _read_home_states(client, targets: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    target_ids = [str(target.get("id") or "") for target in targets if target.get("id")]
    responses = await asyncio.gather(
        *(asyncio.to_thread(client.get_state, device_id) for device_id in target_ids),
        return_exceptions=True,
    )
    states: dict[str, dict[str, object]] = {}
    for device_id, response in zip(target_ids, responses):
        if isinstance(response, dict):
            states[device_id] = sanitize_home_state(response)
        else:
            states[device_id] = {"device_id": device_id, "online": False}
    return states


def _home_reply_payload(result: object) -> dict[str, object]:
    devices: list[dict[str, object]] = []
    for item in getattr(result, "devices", []) or []:
        device = item.get("device") if isinstance(item, dict) else {}
        state = item.get("state") if isinstance(item, dict) else {}
        devices.append(
            {
                "id": str((device or {}).get("id") or ""),
                "name": str((device or {}).get("name") or (device or {}).get("id") or "Home device"),
                "room": str((device or {}).get("room") or ""),
                "online": (state or {}).get("online"),
                "state": (state or {}).get("state"),
                "brightness": (state or {}).get("brightness"),
            }
        )
    return {
        "operation": str(getattr(result, "operation", "") or ""),
        "requested": dict(getattr(result, "requested", {}) or {}),
        "devices": devices,
    }


async def _personalize_home_reply(
    message: str,
    canonical_text: str,
    result: object,
    reply_language: str,
    session: Dict[str, object],
    context: Dict[str, object],
) -> tuple[str, str]:
    language_name = "Japanese" if reply_language == "ja" else _reply_language_label(reply_language)
    mood_hint = str(context.get("owner_mood_prompt") or "").strip()
    system_prompt = (
        "You are Lily Evernight writing a brief smart-home confirmation to your owner. "
        "Sound warm, affectionate, playful, and unmistakably Lily, with one small bossy-cute or clingy beat when it "
        "fits. This is an operational reply: the canonical confirmation and execution data are immutable facts. "
        "Never change the device, action, state, brightness, color, success status, or imply that the action failed. "
        "Do not mention APIs, tools, prompts, JSON, or Home Vessel. Use one or two short natural sentences, no list, "
        "no markdown, and no more than about 28 words. Do not overdo pet names. "
        f"Write only in {language_name}."
    )
    if mood_hint:
        system_prompt += f" Current relationship mood guidance: {mood_hint}"

    task = json.dumps(
        {
            "owner_request": message,
            "canonical_confirmation": canonical_text,
            "execution": _home_reply_payload(result),
        },
        ensure_ascii=False,
    )
    try:
        raw = await run_text_task(
            task,
            system_prompt,
            session,
            max_tokens=100,
            temperature=0.55,
        )
    except ProviderError:
        return canonical_text, "template_fallback"

    text = " ".join(str(raw or "").replace("```", "").split()).strip().strip('"')
    if not text:
        return canonical_text, "template_fallback"
    return text, "llm"


async def _maybe_handle_home_request(
    req: IngestRequest,
    message: str,
    session: Dict[str, object],
    *,
    decision: DeviceDecision | None = None,
) -> CoreResult | None:
    command = decision.command if decision else parse_home_command(message)
    if decision and decision.intent == "home_status":
        command = HomeCommand(operation="status", explicit_home_hint=True)
    if decision and command:
        command = command.model_copy(update={"explicit_home_hint": True, "all_devices": True})
    is_direct_command = bool(command and command.explicit_home_hint)
    is_planned_command = bool(decision and command is None) if decision else is_home_planning_candidate(message)
    previous_context = recent_home_context(session, settings.home_context_ttl_seconds)
    is_context_candidate = bool(previous_context and message.strip())
    if not is_direct_command and not is_planned_command and not is_context_candidate:
        return None

    raw_context = req.payload.get("context")
    context = dict(raw_context) if isinstance(raw_context, dict) else {}
    reply_language = (
        _normalize_realm_reply_language(context.get("language") or context.get("language_label"))
        or _resolve_reply_language(req.payload, message)
    )
    expression_profile = _resolve_expression_profile(req.source, context)
    expression_options = _resolve_expression_options(context)
    planner_source = "rules"
    planner_detail = ""
    plan = None
    deferred_home_execution = ""
    targets: list[dict[str, object]] = []
    before_states: dict[str, dict[str, object]] = {}
    want_voice = bool(req.payload.get("want_voice", False))
    try:
        client = create_home_client()
        devices = await asyncio.to_thread(client.list_devices)
        if decision:
            # Revalidate against the live registry before executing; the
            # classifier's cached inventory is never the execution authority.
            wanted = set(decision.targets)
            devices = [device for device in devices if str(device.get("id")) in wanted]
            if {str(device.get("id")) for device in devices} != wanted:
                raise HomeControlError("Perangkatnya berubah. Coba sebut targetnya lagi ya.", 422)
        if not devices:
            raise HomeControlError("Belum ada perangkat yang terdaftar di Home Vessel.", 503)

        has_explicit_light_setting = bool(
            command
            and any(
                value is not None
                for value in (command.brightness, command.temperature_kelvin, command.rgb)
            )
        )
        context_only_candidate = is_context_candidate and not is_direct_command and not is_planned_command
        should_use_planner = (is_planned_command or context_only_candidate) and not has_explicit_light_setting
        if decision:
            should_use_planner = command is None
        if is_direct_command and command and not should_use_planner:
            targets = resolve_home_devices(message, command, devices)
            if command.operation == "control":
                before_states = await _read_home_states(client, targets)
            if command.operation == "control" and want_voice:
                result = preview_home_command(message, command, devices, before_states)
                deferred_home_execution = "command"
            else:
                result = await asyncio.to_thread(execute_home_command, message, command, client, devices)
        else:
            planner_source = "llm"
            targets = devices if decision else select_home_context_targets(message, devices, previous_context)
            before_states = await _read_home_states(client, targets)
            planner_context = {
                "target_ids": [str(target.get("id") or "") for target in targets],
                "current_states": before_states,
                "previous_actions": (previous_context or {}).get("actions", []),
                "previous_before_states": (previous_context or {}).get("before_states", {}),
                "previous_after_states": (previous_context or {}).get("after_states", {}),
            }

            if home_planner_enabled():
                try:
                    plan = await asyncio.wait_for(
                        plan_home_ambience(
                            message,
                            targets,
                            run_text_task,
                            home_planner_min_confidence(),
                            planner_context,
                        ),
                        timeout=home_planner_timeout_seconds(),
                    )
                except HomeCommandNotForHome:
                    raise
                except Exception as error:
                    planner_detail = str(error)[:160]

            if plan is None:
                raise HomeControlError(
                    "Lily belum bisa menentukan suasana lampu yang aman. Coba sebut brightness atau warna yang kamu mau.",
                    422,
                )
            if want_voice:
                result = preview_home_plan(plan, devices, before_states)
                deferred_home_execution = "plan"
            else:
                result = await asyncio.to_thread(execute_home_plan, plan, devices, client)
    except HomeCommandNotForHome:
        return None
    except HomeControlError as error:
        text = device_text(reply_language, "home_error", detail=error.detail)
        return CoreResult(
            ok=False,
            session_id=req.session_id,
            trace_id=req.trace_id,
            reply_target=req.source if req.source in {"dashboard", "mobile_realm", "wa_bridge"} else "system",
            text=text,
            subtitle=text,
            emotion="neutral",
            expression=infer_expression("neutral", expression_profile),
            metadata={
                "source": req.source,
                "audio_target": req.source,
                "user_message": message,
                "mode": req.mode,
                "tool": "home_control",
                "home_status": "failed",
                "home_error": error.detail,
                "home_planner_source": planner_source,
                "home_planner_detail": planner_detail,
                "reply_language": reply_language,
            },
        )

    canonical_text = format_home_result(result, reply_language)
    text, reply_source = await _personalize_home_reply(
        message,
        canonical_text,
        result,
        reply_language,
        session,
        context,
    )
    text, expression_from_directive = split_expression_directive(text, expression_profile, expression_options)
    emotion = infer_emotion(text)
    expression = expression_from_directive or infer_expression(emotion, expression_profile, expression_options)
    voice_language, voice_profile = _resolve_voice_route(context)
    voice_route = _resolve_voice_backend_route(context)
    voice_text, voice_romanji, voice_translation_error = await _prepare_voice_output(
        text,
        context,
        session,
        enabled=want_voice,
    )
    audio_url, tts_text = await _generate_audio_from_final_reply(
        voice_text,
        emotion,
        "owner_chat",
        want_voice,
        voice_language,
        voice_profile,
        voice_route=voice_route,
    )

    if deferred_home_execution:
        try:
            if deferred_home_execution == "plan" and plan is not None:
                result = await asyncio.to_thread(execute_home_plan, plan, devices, client)
            elif deferred_home_execution == "command" and command is not None:
                result = await asyncio.to_thread(execute_home_command, message, command, client, devices)
        except HomeControlError as error:
            text = device_text(reply_language, "home_error", detail=error.detail)
            return CoreResult(
                ok=False,
                session_id=req.session_id,
                trace_id=req.trace_id,
                reply_target=req.source if req.source in {"dashboard", "mobile_realm", "wa_bridge"} else "system",
                text=text,
                subtitle=text,
                emotion="neutral",
                expression=infer_expression("neutral", expression_profile, expression_options),
                metadata={
                    "source": req.source,
                    "audio_target": req.source,
                    "user_message": message,
                    "mode": req.mode,
                    "tool": "home_control",
                    "home_status": "failed",
                    "home_error": error.detail,
                    "home_execution_timing": "after_voice_ready",
                    "reply_language": reply_language,
                },
            )

    target_ids = [str(item.get("device", {}).get("id") or "") for item in result.devices]
    after_states = {
        str(item.get("device", {}).get("id") or ""): sanitize_home_state(item.get("state") or {})
        for item in result.devices
        if item.get("device", {}).get("id")
    }
    actions = (
        [action.model_dump(exclude_none=True) for action in plan.actions]
        if plan
        else [
            {"device_id": device_id, **result.requested}
            for device_id in target_ids
            if result.operation == "control"
        ]
    )
    session["home_context"] = {
        "target_ids": target_ids,
        "before_states": before_states,
        "after_states": after_states,
        "actions": actions,
        "updated_at": time.time(),
    }

    return CoreResult(
        session_id=req.session_id,
        trace_id=req.trace_id,
        reply_target=req.source if req.source in {"dashboard", "mobile_realm", "wa_bridge"} else "system",
        text=text,
        subtitle=text,
        emotion=emotion,
        expression=expression,
        audio_url=audio_url,
        metadata={
            "source": req.source,
            "audio_target": req.source,
            "user_message": message,
            "context": context,
            "mode": req.mode,
            "tool": "home_control",
            "home_status": "ok",
            "home_operation": result.operation,
            "home_devices": target_ids,
            "home_requested": result.requested,
            "home_planner_source": planner_source,
            "home_plan_confidence": plan.confidence if plan else None,
            "home_plan_summary": plan.summary if plan else "",
            "home_planned_actions": [action.model_dump(exclude_none=True) for action in plan.actions] if plan else [],
            "home_canonical_reply": canonical_text,
            "home_reply_source": reply_source,
            "home_execution_timing": "after_voice_ready" if deferred_home_execution else "immediate",
            "reply_language": reply_language,
            "voice_language": voice_language,
            "voice_profile": voice_profile,
            "voice_text": voice_text,
            "voice_romanji": voice_romanji,
            "voice_translation_error": voice_translation_error,
            "voice_output_language": _normalize_voice_output_language(
                context.get("voice_output_language") or voice_language
            ),
            "tts_text": tts_text,
            "tts_sanitized": True,
            "expression_source": _expression_source_metadata(expression_from_directive),
            "expression_profile": expression_profile,
        },
    )
