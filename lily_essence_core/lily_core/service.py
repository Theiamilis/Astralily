import re
import time
import uuid
from .request_progress import with_request_progress
from datetime import datetime, timezone
from typing import Any, Dict

from .expression_directives import expression_for_mood, infer_emotion, split_expression_directive
from .handlers import handle_dashboard, handle_mobile_realm, handle_stream_stage, handle_tiktok_bridge, handle_wa_bridge
from .live_context import resolve_live_event_priority, update_live_context
from .language_practice import handle_language_practice
from .listener_response import complete_listener_reply
from .mobile_audio import prepare_mobile_audio
from .openclaw_tools import get_openclaw_health
from .owner_mood import OwnerMoodEngine
from .owner_presence import (
    available_owner_presence,
    normalize_owner_presence,
    resolve_owner_presence,
    unknown_owner_presence,
)
from .owner_routines import OwnerRoutineEngine
from .providers import (
    ProviderError,
    get_brain_health,
    get_stream_voice_health,
    get_vision_health,
    get_voice_health,
    get_voice_queue_snapshot,
    resolve_effective_voice_route,
    run_brain,
)
from .schemas import CoreResult, IngestRequest
from .sessions import SessionManager, build_conversation_context
from .settings import settings
from .state_store import core_state_store
from .tts_sanitizer import sanitize_for_tts
from .wa_owner_state import WaOwnerState


def _model_dump(model: Any) -> Dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


def _compact_proactive_text(value: object, max_words: int = 18, max_chars: int = 140) -> str:
    text = " ".join(str(value or "").split()).strip()
    if not text:
        return ""
    words = text.split()
    if len(words) <= max_words and len(text) <= max_chars:
        return text
    compact = " ".join(words[:max_words])[: max(1, max_chars - 3)].rstrip(" ,;:-")
    if compact and compact[-1] not in ".!?~":
        compact += "..."
    return compact


class LilyCoreService:
    def __init__(self) -> None:
        self.state_store = core_state_store
        self.session_manager = SessionManager(max_events=settings.max_session_events, store=self.state_store)
        self.owner_presence: Dict[str, Any] = (
            self.state_store.load_runtime_state("owner_presence_v2") or available_owner_presence()
        )
        self.owner_activity: Dict[str, Any] = self.state_store.load_runtime_state("owner_activity_v1") or {}
        self.wa_runtime: Dict[str, Any] = self.state_store.load_runtime_state("wa_runtime_v1") or {
            "profiles": {}
        }
        self.owner_mood = OwnerMoodEngine(
            self.state_store,
            timezone_name=getattr(settings, "owner_timezone", "Asia/Jakarta"),
        )
        self.owner_routines = OwnerRoutineEngine(
            self.state_store,
            timezone_name=getattr(settings, "owner_timezone", "Asia/Jakarta"),
        )
        self.wa_owner_state = WaOwnerState(self.state_store)

    def _ensure_trace(self, request: IngestRequest) -> str:
        if not request.trace_id:
            request.trace_id = f"trace_{uuid.uuid4().hex[:10]}"
        return request.trace_id

    def _resolve_priority(self, request: IngestRequest) -> int:
        if request.priority is not None:
            return request.priority

        if request.source in {"dashboard", "mobile_realm", "listener"} and request.mode in {"owner_chat", "language_practice"}:
            return 95
        if request.source == "system":
            return 90
        if request.source == "stream_stage":
            return int(resolve_live_event_priority(request.source, request.payload).get("score") or 60)
        if request.source == "tiktok_bridge":
            return int(resolve_live_event_priority(request.source, request.payload).get("score") or 50)
        if request.source == "wa_bridge":
            return 40
        return 10

    def _cooldown_block(self, request: IngestRequest, session: Dict[str, Any]) -> str | None:
        now = time.time()

        if request.source == "stream_stage" and request.mode in ("gaming_companion", "coding_companion"):
            last_vision = float(session.get("last_vision_at", 0.0))
            delta_ms = (now - last_vision) * 1000
            if delta_ms < settings.live_vision_cooldown_ms:
                return "live_vision_cooldown"

        if request.mode == "secretary":
            last_spoken = float(session.get("last_spoken_at", 0.0))
            delta_ms = (now - last_spoken) * 1000
            if delta_ms < settings.wa_auto_reply_cooldown_ms:
                return "wa_reply_cooldown"

        return None

    def _touch_tiktok_session(
        self,
        request: IngestRequest,
        session: Dict[str, Any],
        priority_info: Dict[str, Any],
    ) -> None:
        now = time.time()
        payload = request.payload or {}
        sender_name = str(payload.get("sender_name") or "").strip()
        event_type = str(payload.get("event_type") or "viewer_chat").strip() or "viewer_chat"
        live_context = update_live_context(session, payload, priority_info)

        session["tiktok_connected"] = True
        session["tiktok_last_heartbeat_at"] = now
        session["tiktok_last_event_at"] = now
        session["tiktok_last_event_type"] = event_type
        session["tiktok_last_event_priority"] = priority_info.get("label")
        session["tiktok_last_event_priority_score"] = int(priority_info.get("score") or 0)
        session["tiktok_event_count"] = int(session.get("tiktok_event_count") or 0) + 1
        session["tiktok_status_detail"] = (
            f"Forwarding {event_type} from {sender_name or 'TikTok'} "
            f"as {priority_info.get('label') or 'normal'} priority."
        )
        session["tiktok_live_mood"] = live_context.get("mood")
        if sender_name:
            session["tiktok_last_sender"] = sender_name

    def _publish_tiktok_viewer_chat(self, request: IngestRequest) -> None:
        if request.source != "tiktok_bridge":
            return
        payload = request.payload if isinstance(request.payload, dict) else {}
        event_type = str(payload.get("event_type") or "viewer_chat").strip().lower()
        message = " ".join(str(payload.get("user_message") or payload.get("message") or "").split())[:280]
        if (
            event_type not in {"viewer_chat", "chat", "comment", "message"}
            or bool(payload.get("is_owner_chat"))
            or not message
        ):
            return

        sender = " ".join(str(payload.get("sender_name") or "TikTok viewer").split())[:48]
        self.state_store.publish(
            "hud.live_chat",
            {
                "source": "tiktok_bridge",
                "session_id": request.session_id,
                "sender": sender or "TikTok viewer",
                "message": message,
                "platform": "TikTok",
            },
        )

    @staticmethod
    def _is_owner_interaction(request: IngestRequest) -> bool:
        if request.mode not in {"owner_chat", "owner_tool"}:
            return False
        if request.source in {"dashboard", "mobile_realm", "listener"}:
            return True
        return (
            request.source == "wa_bridge"
            and request.payload.get("is_owner") is True
            and str(request.payload.get("access_scope") or "").strip().lower() == "owner"
        )

    @staticmethod
    def _owner_message(request: IngestRequest) -> str:
        return str(request.payload.get("message") or "").strip()

    @classmethod
    def _supports_conversation_context(cls, request: IngestRequest) -> bool:
        return cls._is_owner_interaction(request) or request.mode in {"public_chat", "language_practice"}

    @staticmethod
    def _owner_control_result(
        request: IngestRequest,
        mood_observation: Dict[str, Any],
    ) -> CoreResult:
        state = mood_observation.get("state") if isinstance(mood_observation.get("state"), dict) else {}
        text = str(mood_observation.get("control_reply") or "").strip()
        target = "mobile_realm" if request.source == "mobile_realm" else (
            "wa_bridge" if request.source == "wa_bridge" else "dashboard"
        )
        expression = str(state.get("expression") or "Blush")
        return CoreResult(
            session_id=request.session_id,
            trace_id=request.trace_id,
            reply_target=target,
            text=text,
            subtitle=text,
            emotion=str(state.get("mood") or "neutral"),
            expression=expression,
            metadata={
                "source": request.source,
                "audio_target": target,
                "mode": request.mode,
                "owner_mood": state,
                "mood_expression": expression,
                "mood_control": mood_observation.get("control"),
                "expression_source": "owner_mood_control",
            },
        )

    @with_request_progress
    async def ingest(self, request: IngestRequest) -> Dict[str, Any]:
        trace_id = self._ensure_trace(request)
        request.payload = request.payload or {}
        if request.source == "listener":
            request.payload["require_tool_approval"] = True
        # Publish viewer comments immediately; the live response may still wait on an LLM.
        self._publish_tiktok_viewer_chat(request)
        active_presence = self.get_owner_presence()
        request.payload.setdefault("owner_presence", active_presence)
        raw_context = request.payload.get("context")
        if isinstance(raw_context, dict):
            raw_context.setdefault("owner_presence", active_presence)

        wa_profile = str(
            request.payload.get("wa_profile")
            or (raw_context.get("wa_profile") if isinstance(raw_context, dict) else "")
            or ""
        ).strip().lower()
        if self._is_owner_interaction(request) and wa_profile:
            self.wa_owner_state.record_owner_message(self._owner_message(request), wa_profile)
            if not isinstance(raw_context, dict):
                raw_context = {}
                request.payload["context"] = raw_context
            pinned_prompt = self.wa_owner_state.pinned_prompt()
            if pinned_prompt:
                raw_context["pinned_owner_memory"] = pinned_prompt

        session = self.session_manager.get_or_create(request.session_id, request.mode)
        session["last_source"] = request.source
        if self._supports_conversation_context(request):
            conversation_context = build_conversation_context(
                self.session_manager.get_events(request.session_id, limit=settings.max_session_events),
                max_turns=settings.conversation_context_turns,
                older_summary_turns=settings.conversation_context_summary_turns,
                max_chars=settings.conversation_context_max_chars,
                user_label="Circle member" if request.mode == "public_chat" else "Owner",
                compacted_summary=str(session.get("conversation_digest") or ""),
            )
            if conversation_context:
                request.payload["recent_conversation_context"] = conversation_context
        priority = self._resolve_priority(request)
        mood_observation: Dict[str, Any] | None = None
        control_result: CoreResult | None = None

        if self._is_owner_interaction(request):
            mood_observation = self.owner_mood.observe(
                self._owner_message(request),
                source=request.source,
                now=request.timestamp,
            )
            mood_state = mood_observation["state"]
            request.payload["owner_mood"] = mood_state
            if not isinstance(raw_context, dict):
                raw_context = {}
                request.payload["context"] = raw_context
            raw_context["owner_mood"] = mood_state
            raw_context["owner_mood_prompt"] = self.owner_mood.prompt_context(
                mood_state,
                important=bool(mood_observation.get("important")),
                aftercare=bool(mood_observation.get("aftercare")),
            )
            raw_context["owner_mood_important"] = bool(mood_observation.get("important"))
            if mood_observation.get("control"):
                control_result = self._owner_control_result(request, mood_observation)

        cooldown_reason = self._cooldown_block(request, session)
        if cooldown_reason:
            return {
                "ok": True,
                "queued": False,
                "skipped": True,
                "reason": cooldown_reason,
                "trace_id": trace_id,
                "priority": priority,
                "session_id": request.session_id,
            }

        priority_info: Dict[str, Any] = {}

        if request.source in {"tiktok_bridge", "stream_stage"}:
            priority_info = resolve_live_event_priority(request.source, request.payload)
            if request.source == "tiktok_bridge" and priority_info.get("should_reply"):
                request.payload["want_reply"] = True

        if request.mode == "language_practice":
            result = await handle_language_practice(request, session)
            self.session_manager.touch(request.session_id, "last_spoken_at")
        elif control_result is not None:
            result = control_result
            self.session_manager.touch(request.session_id, "last_spoken_at")
        elif request.source in {"dashboard", "listener"}:
            result = await handle_dashboard(request, session)
            self.session_manager.touch(request.session_id, "last_spoken_at")
        elif request.source == "mobile_realm":
            result = await handle_mobile_realm(request, session)
            self.session_manager.touch(request.session_id, "last_spoken_at")
        elif request.source == "stream_stage":
            result = await handle_stream_stage(request, session)
            self.session_manager.touch(request.session_id, "last_vision_at")
            self.session_manager.touch(request.session_id, "last_spoken_at")
        elif request.source == "tiktok_bridge":
            self._touch_tiktok_session(request, session, priority_info)
            result = await handle_tiktok_bridge(request, session)
            if result.text:
                self.session_manager.touch(request.session_id, "last_spoken_at")
        elif request.source == "wa_bridge":
            result = await handle_wa_bridge(request, session)
            self.session_manager.touch(request.session_id, "last_spoken_at")
        else:
            result = CoreResult(
                ok=False,
                trace_id=trace_id,
                session_id=request.session_id,
                reply_target="system",
                text=f"Unsupported source '{request.source}'.",
                metadata={"priority": priority},
            )

        result.metadata = result.metadata or {}
        if request.source == "listener":
            await complete_listener_reply(result, request, session)
        result.metadata.setdefault("priority", priority)
        result.metadata.setdefault("voice_queue", get_voice_queue_snapshot())
        raw_context = request.payload.get("context") if isinstance(request.payload, dict) else None
        route_context = raw_context if isinstance(raw_context, dict) else request.payload
        requested_voice_route = str(route_context.get("voice_route") or "").strip().lower()
        if request.source == "stream_stage":
            requested_stream_route = str(route_context.get("voice_route") or "").strip().lower()
            if requested_stream_route in settings.VOICE_ROUTES or requested_stream_route in {"stream_stage", "stream_voice"}:
                effective_voice_route = requested_stream_route
            else:
                effective_voice_route = settings.stream_stage_voice_route
        elif requested_voice_route in settings.VOICE_ROUTES:
            effective_voice_route = requested_voice_route
        else:
            effective_voice_route = settings.voice_provider
        effective_voice_route = resolve_effective_voice_route(
            effective_voice_route,
            str(route_context.get("voice_language") or route_context.get("language") or settings.voice_language),
        )
        result.metadata.setdefault("voice_route", effective_voice_route)
        result.metadata.setdefault(
            "voice_provider",
            settings.stream_voice_provider
            if effective_voice_route in {"stream_stage", "stream_voice", "rvc"}
            else effective_voice_route,
        )
        result.metadata.setdefault("owner_presence", self.get_owner_presence())
        if mood_observation:
            mood_state = mood_observation["state"]
            mood_expression = str(mood_state.get("expression") or "Blush")
            result.metadata.setdefault("owner_mood", mood_state)
            result.metadata.setdefault("mood_expression", mood_expression)
            result.metadata.setdefault("mood_important", bool(mood_observation.get("important")))
            result.metadata.setdefault("mood_aftercare", bool(mood_observation.get("aftercare")))
            result.metadata.setdefault("reaction_expression", result.expression)
            if (
                not mood_observation.get("control")
                and
                not mood_observation.get("important")
                and (
                    not result.expression
                    or result.expression == "Blush"
                    or str(mood_state.get("last_trigger") or "") != "conversation"
                )
            ):
                result.expression = mood_expression
                result.metadata["expression_source"] = "owner_mood"
            if mood_observation.get("aftercare"):
                self.owner_mood.consume_aftercare()
        if result.text:
            result.metadata.setdefault("tts_text", sanitize_for_tts(result.text))
            result.metadata.setdefault("tts_sanitized", True)
        if priority_info:
            result.metadata["live_event_priority"] = int(priority_info.get("score") or priority)
            result.metadata["live_event_priority_label"] = priority_info.get("label")
            result.metadata["live_event_priority_reason"] = priority_info.get("reason")
            result.metadata["live_event_should_reply"] = bool(priority_info.get("should_reply"))
        if request.source == "tiktok_bridge" and isinstance(session.get("live_context"), dict):
            result.metadata["live_context"] = session["live_context"]

        if request.source == "mobile_realm" and result.audio_url:
            result.audio_url = await prepare_mobile_audio(result.audio_url)
            if not result.audio_url:
                result.metadata["voice_error"] = "Audio is unavailable through Core."
        event = _model_dump(result)
        event["created_at"] = time.time()
        event["priority"] = priority
        self.session_manager.push_event(request.session_id, event, event_type=request.source)
        runtime_event_type = "core.result"
        if request.source in {"stream_stage", "tiktok_bridge"}:
            runtime_event_type = "live.updated"
        elif result.metadata.get("tool") == "home_control":
            runtime_event_type = "home.updated"
        self.state_store.publish(
            runtime_event_type,
            {
                "session_id": request.session_id,
                "source": request.source,
                "trace_id": trace_id,
                "priority": priority,
                "voice_queue": result.metadata.get("voice_queue"),
                "owner_mood": result.metadata.get("owner_mood"),
                "mood_expression": result.metadata.get("mood_expression"),
            },
        )
        if request.source != "listener" and request.source.strip().lower() in settings.hud_event_sources:
            hud_has_content = bool(event.get("text") or event.get("audio_url"))
            self.state_store.publish(
                "hud.state",
                {
                    "event": "SPEAKING" if hud_has_content else "IDLE",
                    "state": "SPEAKING" if hud_has_content else "IDLE",
                    "source": request.source,
                    "session_id": request.session_id,
                    "trace_id": trace_id,
                    "text": str(event.get("text") or ""),
                    "audio_url": str(event.get("audio_url") or ""),
                    "expression": str(event.get("expression") or ""),
                    "emotion": str(event.get("emotion") or ""),
                },
            )

        return {
            "ok": result.ok,
            "trace_id": trace_id,
            "priority": priority,
            "result": event,
        }

    def get_state(self) -> Dict[str, Any]:
        components = self.get_component_health()
        overall = "ok"
        if any(
            component.get("status") in {"offline", "degraded"}
            and bool(component.get("required", False))
            for component in components.values()
            if isinstance(component, dict)
        ):
            overall = "degraded"

        return {
            "status": overall,
            "providers": {
                "brain": settings.brain_provider,
                "text_fallback": settings.text_fallback_provider,
                "text_chain": settings.text_provider_chain,
                "vision": settings.vision_provider,
                "stream_stage_vision": settings.stream_stage_vision_provider or settings.vision_provider,
                "voice": settings.voice_provider,
                "stream_voice": settings.stream_voice_provider,
            },
            "sessions": self.session_manager.state(),
            "components": components,
            "owner_presence": self.get_owner_presence(),
            "owner_mood": self.get_owner_mood(),
            "owner_routines": self.get_owner_routines(),
            "owner_runtime": self.get_owner_runtime(),
        }

    def get_owner_presence(self) -> Dict[str, Any]:
        was_automatic = bool(self.owner_presence.get("automatic", False))
        self.owner_presence = resolve_owner_presence(self.owner_presence)
        self.owner_presence["automatic"] = was_automatic
        if was_automatic and self.owner_activity.get("observed_at"):
            try:
                observed_at = datetime.fromisoformat(
                    str(self.owner_activity["observed_at"]).replace("Z", "+00:00")
                )
                idle_seconds = max(0.0, (datetime.now(timezone.utc) - observed_at).total_seconds())
                if idle_seconds <= 30 * 60:
                    self.owner_presence = normalize_owner_presence(
                        {
                            "status": "available",
                            "source": "system",
                            "note": f"Recent {self.owner_activity.get('activity', 'activity')} event from {self.owner_activity.get('source', 'device')}.",
                        }
                    )
                else:
                    self.owner_presence = unknown_owner_presence()
                self.owner_presence["automatic"] = True
                self.owner_presence["confidence"] = (
                    str(self.owner_activity.get("confidence") or "medium")
                    if idle_seconds <= 30 * 60
                    else "low"
                )
                self.owner_presence["signal_age_seconds"] = int(idle_seconds)
            except (TypeError, ValueError):
                pass
        return dict(self.owner_presence)

    def set_owner_presence(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self.owner_presence = normalize_owner_presence(payload)
        self.owner_presence["automatic"] = False
        self.state_store.save_runtime_state("owner_presence_v2", self.owner_presence)
        return {
            "ok": True,
            "owner_presence": self.get_owner_presence(),
        }

    def observe_owner_activity(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        activity = str(payload.get("activity") or "app_foreground").strip().lower()[:32]
        status = {
            "gaming": "gaming",
            "working": "at_office",
            "sleeping": "sleeping",
            "away": "away",
            "busy": "busy",
        }.get(activity, "available")
        confidence = str(payload.get("confidence") or "medium").strip().lower()
        if confidence not in {"low", "medium", "high"}:
            confidence = "medium"
        now = datetime.now(timezone.utc)
        self.owner_activity = {
            "activity": activity,
            "source": str(payload.get("source") or "system").strip()[:32],
            "device_id": str(payload.get("device_id") or "").strip()[:80],
            "confidence": confidence,
            "observed_at": now.isoformat(),
        }
        self.state_store.save_runtime_state("owner_activity_v1", self.owner_activity)
        current = resolve_owner_presence(self.owner_presence)
        if not current.get("active") or current.get("automatic"):
            self.owner_presence = normalize_owner_presence(
                {
                    "status": status,
                    "source": "system",
                    "note": f"Recent {activity} event from {self.owner_activity['source']}.",
                    "ttl_minutes": 15 if status == "available" else 120,
                }
            )
            self.owner_presence["automatic"] = True
            self.owner_presence["confidence"] = confidence
            self.state_store.save_runtime_state("owner_presence_v2", self.owner_presence)
        return {
            "ok": True,
            "owner_activity": dict(self.owner_activity),
            "owner_presence": self.get_owner_presence(),
        }

    def get_owner_routines(self) -> Dict[str, Any]:
        return self.owner_routines.snapshot()

    def set_owner_routine_enabled(self, routine_id: str, enabled: bool) -> Dict[str, Any]:
        return self.owner_routines.set_enabled(routine_id, enabled)

    def set_owner_routines_enabled(self, enabled: bool) -> Dict[str, Any]:
        return self.owner_routines.set_mLily-Voice-Host_enabled(enabled)

    def claim_owner_routine(self, profile: str) -> Dict[str, Any]:
        result = self.owner_routines.claim_due(profile)
        if result.get("due"):
            self.state_store.publish(
                "routine.due",
                {
                    "profile": profile,
                    "routine": result.get("routine"),
                    "text": result.get("text"),
                },
            )
        return result

    def acknowledge_owner_routine(
        self,
        *,
        delivery_id: str,
        lease_token: str,
        success: bool,
        profile: str,
        error: str = "",
    ) -> Dict[str, Any]:
        result = self.owner_routines.acknowledge_delivery(
            delivery_id,
            lease_token,
            success,
            profile,
            error,
        )
        if result.get("accepted"):
            self.state_store.publish(
                "routine.delivery",
                {
                    "delivery_id": delivery_id,
                    "profile": profile,
                    "status": result.get("delivery", {}).get("status"),
                },
            )
        return result

    def report_wa_runtime(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        profile = str(payload.get("profile") or "").strip().lower()
        if profile not in {"personal", "public"}:
            raise ValueError("Unknown WhatsApp profile.")
        now = datetime.now(timezone.utc)
        profiles = self.wa_runtime.setdefault("profiles", {})
        previous = profiles.get(profile) if isinstance(profiles.get(profile), dict) else {}
        routine_delivery = payload.get("routine_delivery")
        if not isinstance(routine_delivery, dict):
            routine_delivery = previous.get("routine_delivery") if isinstance(previous, dict) else None
        current = {
            "profile": profile,
            "ready": bool(payload.get("ready", False)),
            "client_state": str(payload.get("client_state") or "unknown").strip()[:40],
            "state_updated_at": str(payload.get("state_updated_at") or "").strip()[:64] or None,
            "last_seen_at": now.isoformat(),
            "routine_delivery": routine_delivery,
        }
        changed = any(
            previous.get(key) != current.get(key)
            for key in ("ready", "client_state", "state_updated_at", "routine_delivery")
        )
        profiles[profile] = current
        self.wa_runtime["updated_at"] = now.isoformat()
        self.state_store.save_runtime_state("wa_runtime_v1", self.wa_runtime)
        return {"ok": True, "changed": changed, "profile": dict(current)}

    def get_owner_runtime(self) -> Dict[str, Any]:
        now = datetime.now(timezone.utc)
        profiles: Dict[str, Any] = {}
        stored_profiles = self.wa_runtime.get("profiles") or {}
        for profile in ("personal", "public"):
            item = dict(stored_profiles.get(profile) or {})
            try:
                last_seen = datetime.fromisoformat(str(item.get("last_seen_at") or "").replace("Z", "+00:00"))
                age_seconds = max(0, int((now - last_seen).total_seconds()))
            except (TypeError, ValueError):
                age_seconds = None
            online = bool(item.get("ready")) and age_seconds is not None and age_seconds <= 150
            item.update(
                {
                    "profile": profile,
                    "online": online,
                    "status": "online" if online else "stale" if item else "unknown",
                    "age_seconds": age_seconds,
                }
            )
            profiles[profile] = item

        activity = dict(self.owner_activity)
        try:
            observed_at = datetime.fromisoformat(str(activity.get("observed_at") or "").replace("Z", "+00:00"))
            activity["age_seconds"] = max(0, int((now - observed_at).total_seconds()))
        except (TypeError, ValueError):
            activity["age_seconds"] = None
        return {
            "ok": True,
            "generated_at": now.isoformat(),
            "owner_activity": activity,
            "wa_profiles": profiles,
            "routines": self.get_owner_routines(),
        }

    def get_owner_mood(self) -> Dict[str, Any]:
        return self.owner_mood.snapshot()

    async def claim_proactive_owner_message(
        self,
        *,
        profile: str,
        min_idle_seconds: int,
        cooldown_seconds: int,
        max_per_day: int,
        quiet_hours_active: bool,
    ) -> Dict[str, Any]:
        if quiet_hours_active:
            return {
                "ok": True,
                "due": False,
                "reason": "quiet_hours",
                "owner_mood": self.get_owner_mood(),
            }

        claim = self.owner_mood.claim_proactive(
            profile=profile,
            min_idle_seconds=min_idle_seconds,
            cooldown_seconds=cooldown_seconds,
            max_per_day=max_per_day,
        )
        if not claim.get("due"):
            return {
                "ok": True,
                "due": False,
                "reason": claim.get("reason"),
                "owner_mood": claim.get("state"),
            }

        mood_state = claim["state"]
        mood_prompt = self.owner_mood.prompt_context(mood_state)
        session = self.session_manager.get_or_create("wa_owner", "owner_chat")
        callback_context = build_conversation_context(
            self.session_manager.get_events("wa_owner", limit=settings.max_session_events),
            max_turns=3,
            older_summary_turns=2,
            max_chars=3500,
            user_label="Owner",
            compacted_summary=str(session.get("conversation_digest") or ""),
        )
        pinned_prompt = self.wa_owner_state.pinned_prompt()
        prompt = (
            "Write one proactive WhatsApp message from Lily to her owner after a period of silence.\n"
            f"{mood_prompt}\n"
            f"{pinned_prompt}\n"
            f"{callback_context}\n"
            "Use natural casual Indonesian. Output exactly one compact WhatsApp bubble: one sentence, 8 to 18 words, "
            "and at most 140 characters. Start directly with the interesting emotional beat; omit greeting filler, "
            "explanations, follow-up paragraphs, and multiple questions. "
            "Be clingy, emotionally vivid, and a little unpredictable according to the current mood, but do not "
            "mention timers, systems, mood labels, intensity, or monitoring. Do not guilt-trip seriously and do not "
            "invent an emergency. A callback may be used once if it feels natural, but do not repeat the latest "
            "Lily opening, pet name, or emotional beat. Do not use 'sayang' by default. "
            "First line must be compact JSON with one allowed expression; second line is the message.\n"
            "Allowed expressions: Love, Soft Love, Blush, Shy, Sparkle Mood, Gloomy, Crying, Sweat, Angry."
        )
        try:
            text = await run_brain(prompt, session)
            text, expression_from_directive = split_expression_directive(text, "private_realm")
            text = _compact_proactive_text(text)
            if not text:
                raise ProviderError("Proactive owner reply was empty.")
        except ProviderError:
            self.owner_mood.release_proactive_claim(float(claim.get("claimed_at") or 0.0))
            return {
                "ok": False,
                "due": False,
                "reason": "provider_unavailable",
                "owner_mood": self.get_owner_mood(),
            }

        emotion = infer_emotion(text)
        expression = expression_from_directive or expression_for_mood(str(mood_state.get("mood") or "calm"))
        self.state_store.publish(
            "mood.proactive",
            {
                "profile": profile,
                "mood": mood_state.get("mood"),
                "intensity": mood_state.get("intensity"),
                "expression": expression,
            },
        )
        return {
            "ok": True,
            "due": True,
            "reason": claim.get("reason"),
            "text": text,
            "emotion": emotion,
            "expression": expression,
            "owner_mood": mood_state,
        }

    def _get_tiktok_health(self, live_session: Dict[str, Any]) -> Dict[str, Any]:
        now = time.time()
        heartbeat = float(live_session.get("tiktok_last_heartbeat_at") or 0.0)
        event_at = float(live_session.get("tiktok_last_event_at") or 0.0)
        connected = bool(live_session.get("tiktok_connected", False))
        unique_id = str(live_session.get("tiktok_unique_id") or "").strip()
        event_count = int(live_session.get("tiktok_event_count") or 0)
        age = now - heartbeat if heartbeat else None

        if connected and heartbeat and age <= 45:
            status = "online"
            detail = str(
                live_session.get("tiktok_status_detail")
                or f"TikTok bridge connected{f' to @{unique_id}' if unique_id else ''}."
            )
        elif connected and heartbeat:
            status = "degraded"
            detail = f"TikTok bridge heartbeat stale ({int(age)}s)."
        else:
            status = "idle"
            detail = "TikTok bridge is not connected yet."

        return {
            "status": status,
            "provider": "tiktok_bridge",
            "detail": detail,
            "session_id": "live-main",
            "unique_id": unique_id,
            "heartbeat_age_seconds": round(age, 1) if age is not None else None,
            "last_event_at": event_at or None,
            "last_event_type": live_session.get("tiktok_last_event_type"),
            "last_sender": live_session.get("tiktok_last_sender"),
            "last_event_priority": live_session.get("tiktok_last_event_priority"),
            "last_event_priority_score": live_session.get("tiktok_last_event_priority_score"),
            "live_mood": live_session.get("tiktok_live_mood"),
            "event_count": event_count,
        }

    def get_component_health(self) -> Dict[str, Any]:
        live_session = self.session_manager.sessions.get("live-main", {})
        mic_listening = bool(live_session.get("mic_listening", False))
        mouse_tracking = bool(live_session.get("mouse_tracking", True))

        def optional_health(component_id: str, getter) -> Dict[str, Any]:
            if settings.is_component_disabled(component_id):
                return {
                    "status": "disabled",
                    "provider": "settings",
                    "detail": "Optional component is disabled in Core settings.",
                }
            return getter()

        raw_components = {
            "core": {
                "status": "online",
                "provider": "lily_core",
                "detail": "Core routing is active.",
                "session_count": len(self.session_manager.sessions),
            },
            "stage": {
                "status": "online",
                "provider": "stream_stage",
                "detail": (
                    f"Mic listening is {'enabled' if mic_listening else 'disabled'} and mouse tracking is "
                    f"{'enabled' if mouse_tracking else 'disabled'} for live-main."
                ),
                "session_id": "live-main",
                "mic_listening": mic_listening,
                "mouse_tracking": mouse_tracking,
            },
            "brain": get_brain_health(),
            "vision": get_vision_health(),
            "voice": optional_health("voice", get_voice_health),
            "stream_voice": optional_health("stream_voice", get_stream_voice_health),
            "tiktok": optional_health("tiktok", lambda: self._get_tiktok_health(live_session)),
            "openclaw": optional_health("openclaw", get_openclaw_health),
            "owner_presence": {
                "status": "online",
                "provider": "manual_presence",
                "detail": self.get_owner_presence().get("note") or "Manual owner presence is available.",
                "presence": self.get_owner_presence(),
            },
            "owner_mood": {
                "status": "online",
                "provider": "owner_mood_engine",
                "detail": (
                    f"Lily is {self.get_owner_mood().get('mood')} at "
                    f"{self.get_owner_mood().get('intensity')}/100."
                ),
                "mood": self.get_owner_mood(),
            },
        }
        components: Dict[str, Any] = {}
        for component_id, detail in raw_components.items():
            if settings.is_component_disabled(component_id):
                components[component_id] = {
                    "status": "disabled",
                    "provider": "settings",
                    "detail": "Optional component is disabled in Core settings.",
                    "required": False,
                    "enabled": False,
                }
                continue
            enriched = dict(detail) if isinstance(detail, dict) else {"status": "unknown"}
            enriched["required"] = settings.is_component_required(component_id)
            enriched["enabled"] = True
            components[component_id] = enriched
        return components

    def get_session(self, session_id: str) -> Dict[str, Any]:
        session = self.session_manager.sessions.get(session_id)
        return {
            "session": session,
            "events": self.session_manager.get_events(session_id, limit=settings.max_session_events),
        }

    def get_events(self, session_id: str, limit: int = 10) -> Dict[str, Any]:
        return {
            "session_id": session_id,
            "events": self.session_manager.get_events(session_id, limit=limit),
        }

    def reset_session_conversation(self, session_id: str) -> Dict[str, Any]:
        normalized_session_id = (session_id or "").strip()
        cleared_event_count = self.session_manager.clear_events(normalized_session_id)
        session = self.session_manager.sessions.get(normalized_session_id)
        if session and session.pop("conversation_digest", None) is not None:
            self.state_store.save_session(session)
        if normalized_session_id == "wa_owner":
            self.wa_owner_state.clear_transient()
        return {
            "ok": True,
            "session_id": normalized_session_id,
            "cleared_event_count": cleared_event_count,
            "session_preserved": normalized_session_id in self.session_manager.sessions,
        }

    def forget_latest_session_event(self, session_id: str) -> Dict[str, Any]:
        normalized_session_id = (session_id or "").strip()
        removed = self.session_manager.forget_latest_event(normalized_session_id)
        if normalized_session_id == "wa_owner" and removed is not None:
            next_events = self.session_manager.get_events(normalized_session_id, limit=1)
            next_metadata = (
                next_events[0].get("metadata")
                if next_events and isinstance(next_events[0].get("metadata"), dict)
                else {}
            )
            self.wa_owner_state.replace_last_owner_message(
                str(next_metadata.get("user_message") or ""),
            )
        return {
            "ok": removed is not None,
            "session_id": normalized_session_id,
            "removed": removed,
        }

    def get_wa_owner_state(self) -> Dict[str, Any]:
        snapshot = self.wa_owner_state.snapshot()
        events = self.session_manager.get_events("wa_owner", limit=12)
        recent_topics = []
        for event in events:
            metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
            message = " ".join(str(metadata.get("user_message") or "").split())[:180]
            if message:
                recent_topics.append(message)
        return {
            "ok": True,
            "session_id": "wa_owner",
            "event_count": len(self.session_manager.get_events("wa_owner", limit=settings.max_session_events)),
            "recent_topics": recent_topics,
            **snapshot,
        }

    def pin_wa_owner_memory(self, text: str) -> Dict[str, Any]:
        return {"ok": True, "memory": self.wa_owner_state.pin(text)}

    def unpin_wa_owner_memory(self, index: int) -> Dict[str, Any]:
        removed = self.wa_owner_state.unpin(index)
        return {"ok": removed is not None, "memory": removed}

    def update_session_state(self, session_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        allowed_keys = {
            "mic_listening",
            "mouse_tracking",
            "paused",
            "mode",
            "tiktok_connected",
            "tiktok_unique_id",
            "tiktok_last_heartbeat_at",
            "tiktok_last_event_at",
            "tiktok_last_event_type",
            "tiktok_last_sender",
            "tiktok_event_count",
            "tiktok_status_detail",
            "tiktok_live_mood",
            "live_context",
        }
        sanitized = {key: value for key, value in updates.items() if key in allowed_keys}
        session = self.session_manager.update_session(session_id, sanitized)
        return {
            "session_id": session_id,
            "session": session,
        }

    def get_live_settings(self, session_id: str) -> Dict[str, Any]:
        from .live_settings import live_settings_from_session

        session = self.session_manager.sessions.get(session_id)
        return {
            "session_id": session_id,
            "configured": isinstance(session, dict) and isinstance(session.get("live_settings"), dict),
            "settings": live_settings_from_session(session),
        }

    def save_live_settings(self, session_id: str, values: Dict[str, Any]) -> Dict[str, Any]:
        from .live_settings import live_settings_from_session

        session = self.session_manager.update_session(session_id, {"live_settings": values})
        return {"session_id": session_id, "configured": True, "settings": live_settings_from_session(session)}


core_service = LilyCoreService()
