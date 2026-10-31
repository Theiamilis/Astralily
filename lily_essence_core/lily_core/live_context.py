import time
from typing import Any, Dict


MAX_RECENT_EVENTS = 8
MAX_RECENT_VIEWERS = 6

URGENT_EVENTS = {"danger", "warning", "moderation", "report", "system_alert"}
ENGAGEMENT_EVENTS = {"gift", "subscribe", "subscription", "follow", "share", "like"}
CHAT_EVENTS = {"viewer_chat", "chat", "comment", "message"}


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return bool(value)


def resolve_live_event_priority(source: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    event_type = _clean_text(payload.get("event_type") or "viewer_chat").lower() or "viewer_chat"
    message = _clean_text(payload.get("user_message") or payload.get("message"))
    want_reply = _as_bool(payload.get("want_reply"))
    is_owner_chat = _as_bool(payload.get("is_owner_chat"))

    if source == "stream_stage" and event_type in URGENT_EVENTS:
        return {
            "score": 80,
            "label": "urgent",
            "reason": f"{event_type} stage event",
            "should_reply": True,
        }

    if source != "tiktok_bridge":
        return {
            "score": 50,
            "label": "normal",
            "reason": f"{source} event",
            "should_reply": want_reply,
        }

    if is_owner_chat:
        return {
            "score": 92,
            "label": "owner",
            "reason": "owner chat from live bridge",
            "should_reply": want_reply,
        }

    if event_type in URGENT_EVENTS:
        return {
            "score": 88,
            "label": "urgent",
            "reason": f"{event_type} live event",
            "should_reply": True,
        }

    if want_reply:
        return {
            "score": 72,
            "label": "reply",
            "reason": "live event requested a reply",
            "should_reply": True,
        }

    if event_type in {"gift", "subscribe", "subscription"}:
        return {
            "score": 68,
            "label": "engagement",
            "reason": f"{event_type} live signal",
            "should_reply": False,
        }

    if event_type in {"follow", "share"}:
        return {
            "score": 58,
            "label": "signal",
            "reason": f"{event_type} live signal",
            "should_reply": False,
        }

    if event_type == "like":
        return {
            "score": 52,
            "label": "signal",
            "reason": "like live signal",
            "should_reply": False,
        }

    if event_type in CHAT_EVENTS:
        return {
            "score": 60 if message else 48,
            "label": "chat",
            "reason": "viewer chat",
            "should_reply": False,
        }

    return {
        "score": 45,
        "label": "background",
        "reason": f"{event_type} background event",
        "should_reply": False,
    }


def update_live_context(
    session: Dict[str, Any],
    payload: Dict[str, Any],
    priority_info: Dict[str, Any],
) -> Dict[str, Any]:
    now = time.time()
    context = session.get("live_context")
    if not isinstance(context, dict):
        context = {}

    sender_name = _clean_text(payload.get("sender_name")) or "Viewer"
    event_type = _clean_text(payload.get("event_type") or "viewer_chat") or "viewer_chat"
    message = _clean_text(payload.get("user_message") or payload.get("message"))
    priority_label = _clean_text(priority_info.get("label")) or "normal"
    priority_score = int(priority_info.get("score") or 0)
    should_reply = _as_bool(priority_info.get("should_reply"))

    recent_viewers = [
        _clean_text(viewer)
        for viewer in context.get("recent_viewers", [])
        if _clean_text(viewer)
    ]
    if sender_name != "Viewer":
        recent_viewers = [sender_name] + [viewer for viewer in recent_viewers if viewer != sender_name]

    recent_events = context.get("recent_events", [])
    if not isinstance(recent_events, list):
        recent_events = []

    recent_events = [
        {
            "sender_name": sender_name,
            "event_type": event_type,
            "message": message,
            "priority": priority_score,
            "priority_label": priority_label,
            "should_reply": should_reply,
            "created_at": now,
        },
        *recent_events,
    ][:MAX_RECENT_EVENTS]

    if priority_label in {"urgent", "owner"}:
        mood = "alert"
    elif priority_label in {"reply", "chat"}:
        mood = "engaged"
    elif priority_label in {"engagement", "signal"}:
        mood = "warm"
    else:
        mood = str(context.get("mood") or "standby")

    next_context = {
        "topic": message or context.get("topic") or "",
        "mood": mood,
        "last_sender": sender_name,
        "last_event_type": event_type,
        "last_priority": priority_label,
        "last_priority_score": priority_score,
        "events_seen": int(context.get("events_seen") or 0) + 1,
        "recent_viewers": recent_viewers[:MAX_RECENT_VIEWERS],
        "recent_events": recent_events,
        "updated_at": now,
    }
    session["live_context"] = next_context
    return next_context


def format_live_context_prompt(session: Dict[str, Any]) -> str:
    context = session.get("live_context")
    if not isinstance(context, dict):
        return ""

    recent_events = context.get("recent_events", [])
    if not isinstance(recent_events, list):
        recent_events = []

    lines = [
        "Live session context:",
        f"- Mood: {_clean_text(context.get('mood')) or 'standby'}",
        f"- Current topic: {_clean_text(context.get('topic')) or 'none yet'}",
        f"- Last priority: {_clean_text(context.get('last_priority')) or 'normal'}",
    ]

    viewers = [
        _clean_text(viewer)
        for viewer in context.get("recent_viewers", [])
        if _clean_text(viewer)
    ]
    if viewers:
        lines.append(f"- Recent viewers: {', '.join(viewers[:MAX_RECENT_VIEWERS])}")

    if recent_events:
        lines.append("- Recent live events:")
        for event in recent_events[:4]:
            sender = _clean_text(event.get("sender_name")) or "Viewer"
            event_type = _clean_text(event.get("event_type")) or "event"
            message = _clean_text(event.get("message")) or "(no text)"
            priority = _clean_text(event.get("priority_label")) or "normal"
            lines.append(f"  - [{priority}] {sender} {event_type}: {message}")

    return "\n".join(lines)
