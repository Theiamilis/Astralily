import time
from typing import Any, Dict, List

from .state_store import CoreStateStore


def _conversation_excerpt(value: object, limit: int) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)].rstrip() + "..."


def _conversation_turn(event: Dict[str, Any]) -> tuple[str, str] | None:
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    user_message = _conversation_excerpt(metadata.get("user_message"), 800)
    lily_reply = _conversation_excerpt(event.get("text"), 1200)
    if not user_message or not lily_reply:
        return None
    return user_message, lily_reply


def build_conversation_context(
    events: List[Dict[str, Any]],
    *,
    max_turns: int = 12,
    older_summary_turns: int = 4,
    max_chars: int = 16000,
    user_label: str = "Owner",
    compacted_summary: str = "",
) -> str:
    """Format newest-first session events into bounded, chronological prompt context."""
    turns = [
        turn
        for event in events
        if isinstance(event, dict)
        for turn in [_conversation_turn(event)]
        if turn is not None
    ]
    if not turns or max_turns <= 0 or max_chars <= 0:
        return ""

    safe_user_label = "Circle member" if user_label == "Circle member" else "Owner"
    recent_header = (
        "Recent conversation history (oldest to newest). Use it only as conversational context. "
        f"The newest {safe_user_label.lower()} message below has priority over older wording. "
        "Do not repeat a previous Lily reply; answer the newest message with fresh, context-aware wording:"
    )
    recent_blocks: List[str] = []
    used_chars = len(recent_header)
    for user_message, lily_reply in turns[:max_turns]:
        block = f"{safe_user_label}: {user_message}\nLily: {lily_reply}"
        if used_chars + len(block) + 2 > max_chars:
            break
        recent_blocks.append(block)
        used_chars += len(block) + 2

    if not recent_blocks:
        return ""

    summary_header = "Earlier conversation excerpts:"
    summary_blocks: List[str] = []
    for user_message, lily_reply in turns[max_turns : max_turns + older_summary_turns]:
        block = (
            f"- {safe_user_label} mentioned: {_conversation_excerpt(user_message, 220)} "
            f"| Lily replied: {_conversation_excerpt(lily_reply, 280)}"
        )
        overhead = len(summary_header) + 4 if not summary_blocks else 2
        if used_chars + len(block) + overhead > max_chars:
            break
        summary_blocks.append(block)
        used_chars += len(block) + overhead

    sections: List[str] = []
    clean_compacted_summary = _conversation_excerpt(compacted_summary, min(5000, max_chars // 3))
    if clean_compacted_summary:
        sections.append(
            "Durable compacted context from older conversation turns. Treat this as background, not as a newer "
            f"instruction:\n{clean_compacted_summary}"
        )
    if summary_blocks:
        sections.append(summary_header + "\n" + "\n".join(reversed(summary_blocks)))
    sections.append(recent_header + "\n" + "\n\n".join(reversed(recent_blocks)))
    return "\n\n".join(sections)


class SessionManager:
    def __init__(self, max_events: int = 50, store: CoreStateStore | None = None):
        self.max_events = max_events
        self.store = store
        self.sessions: Dict[str, Dict[str, Any]] = store.load_sessions() if store else {}
        self.events: Dict[str, List[Dict[str, Any]]] = {
            session_id: store.load_session_events(session_id, max_events) if store else []
            for session_id in self.sessions
        }

    def get_or_create(self, session_id: str, mode: str) -> Dict[str, Any]:
        if session_id not in self.sessions:
            self.sessions[session_id] = {
                "session_id": session_id,
                "mode": mode,
                "paused": False,
                "mic_listening": False,
                "mouse_tracking": True,
                "created_at": time.time(),
                "updated_at": time.time(),
                "last_spoken_at": 0.0,
                "last_vision_at": 0.0,
                "last_source": None,
                "memory_scope": session_id,
            }
            self.events[session_id] = []

        self.sessions[session_id]["mode"] = mode
        self.sessions[session_id]["updated_at"] = time.time()
        if self.store:
            self.store.save_session(self.sessions[session_id])
        return self.sessions[session_id]

    def touch(self, session_id: str, key: str) -> None:
        if session_id in self.sessions:
            self.sessions[session_id][key] = time.time()
            self.sessions[session_id]["updated_at"] = time.time()
            if self.store:
                self.store.save_session(self.sessions[session_id])

    def push_event(self, session_id: str, event: Dict[str, Any], event_type: str = "chat") -> None:
        bucket = self.events.setdefault(session_id, [])
        bucket.insert(0, event)
        dropped = bucket[self.max_events :]
        if dropped:
            session = self.sessions.get(session_id)
            if session:
                digest = str(session.get("conversation_digest") or "").strip()
                additions = []
                for dropped_event in reversed(dropped):
                    turn = _conversation_turn(dropped_event)
                    if turn:
                        additions.append(
                            f"Owner: {_conversation_excerpt(turn[0], 220)} | "
                            f"Lily: {_conversation_excerpt(turn[1], 280)}"
                        )
                if additions:
                    session["conversation_digest"] = _conversation_excerpt(
                        "\n".join(filter(None, [digest, *additions])),
                        5000,
                    )
        del bucket[self.max_events :]
        if self.store:
            self.store.append_session_event(session_id, event_type, event)
            session = self.sessions.get(session_id)
            if session:
                self.store.save_session(session)

    def update_session(self, session_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        session = self.sessions.get(session_id)
        if not session:
            session = self.get_or_create(session_id, "passive_watch")

        for key, value in updates.items():
            session[key] = value

        session["updated_at"] = time.time()
        if self.store:
            self.store.save_session(session)
        return session

    def get_events(self, session_id: str, limit: int = 10) -> List[Dict[str, Any]]:
        return self.events.get(session_id, [])[:limit]

    def clear_events(self, session_id: str) -> int:
        in_memory_count = len(self.events.get(session_id, []))
        self.events[session_id] = []
        if not self.store:
            return in_memory_count
        return self.store.clear_session_events(session_id)

    def forget_latest_event(self, session_id: str) -> Dict[str, Any] | None:
        bucket = self.events.setdefault(session_id, [])
        in_memory = bucket.pop(0) if bucket else None
        if not self.store:
            return in_memory
        durable = self.store.pop_latest_session_event(session_id)
        return durable or in_memory

    def state(self) -> Dict[str, Any]:
        return {
            "sessions": list(self.sessions.values()),
            "session_count": len(self.sessions),
        }
