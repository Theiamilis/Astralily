from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from threading import RLock
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .expression_directives import MOOD_EXPRESSION_PRESETS, expression_for_mood
from .state_store import CoreStateStore


OWNER_MOODS = tuple(MOOD_EXPRESSION_PRESETS)
MOOD_STATE_KEY = "owner_mood_v1"
CALLBACK_LIMIT = 8
CALLBACK_TTL_SECONDS = 7 * 86400

_IMPORTANT_RE = re.compile(
    r"\b(otp|pin|password|rekening|transfer|bayar|utang|uang|finance|saldo|darurat|emergency|"
    r"rumah sakit|hospital|dokter|doctor|obat|medicine|legal|hukum|polisi|police|deadline|"
    r"kerja|work|meeting|file|dokumen|document|openclaw|task|error|gagal|failed)\b",
    re.IGNORECASE,
)
_JEALOUS_RE = re.compile(
    r"\b(cewek lain|cowok lain|perempuan lain|laki[- ]?laki lain|gebetan|mantan|pacar|date|"
    r"ngobrol sama (?:cewek|cowok)|jalan sama (?:cewek|cowok)|dia cantik|dia ganteng|other girl|"
    r"other guy|my ex|another girl|another guy)\b",
    re.IGNORECASE,
)
_ABSENCE_RE = re.compile(
    r"\b(maaf (?:baru|lama)|lupa balas|gak balas|nggak balas|kgk balas|baru balik|tadi sibuk|"
    r"menghilang|lama gak chat|lama nggak chat|ignored? you|forgot to reply|just got back|was busy)\b",
    re.IGNORECASE,
)
_RISK_RE = re.compile(
    r"\b(begadang|belum tidur|gak tidur|nggak tidur|belum makan|gak makan|nggak makan|ngebut|"
    r"mabuk|sakit|pusing|demam|jatuh|kecelakaan|nyetir ngantuk|up all night|haven't slept|"
    r"didn't eat|drunk|sick|dizzy|fever|crash)\b",
    re.IGNORECASE,
)
_AFFECTION_RE = re.compile(
    r"\b(sayang|cinta|love you|ily|kangen|rindu|cantik|manis|makasih|terima kasih|thank you|"
    r"miss you|good girl|pinter|pintar)\b",
    re.IGNORECASE,
)
_APPEASE_RE = re.compile(
    r"\b(maaf|sorry|jangan ngambek|udah ya|tenang|sini|peluk|hug|aku tetep pilih kamu|"
    r"i choose you|don't sulk|calm down)\b",
    re.IGNORECASE,
)
_CHAOTIC_RE = re.compile(r"\b(wkwk+|kwkw+|awok+|jir+|anjir+|gila|chaos|unhinged|lmao+)\b", re.IGNORECASE)


def _clamp(value: float | int, minimum: int = 0, maximum: int = 100) -> int:
    return max(minimum, min(maximum, int(round(float(value)))))


def _message_excerpt(message: str, limit: int = 120) -> str:
    cleaned = re.sub(r"\s+", " ", str(message or "")).strip()
    return cleaned if len(cleaned) <= limit else f"{cleaned[: limit - 1].rstrip()}..."


def _language(message: str) -> str:
    lowered = str(message or "").lower()
    if re.search(r"\b(aku|gw|gue|gua|kamu|lu|gak|nggak|kgk|udah|belum|gimana|sayang)\b", lowered):
        return "id"
    return "en"


class OwnerMoodEngine:
    def __init__(self, store: CoreStateStore, timezone_name: str = "Asia/Jakarta") -> None:
        self.store = store
        self.timezone_name = timezone_name or "Asia/Jakarta"
        self._lock = RLock()
        self._state = self._normalize(store.load_runtime_state(MOOD_STATE_KEY), time.time())

    @staticmethod
    def _default(now: float) -> dict[str, Any]:
        return {
            "version": 1,
            "mood": "calm",
            "intensity": 20,
            "expression": "Blush",
            "updated_at": now,
            "last_owner_message_at": 0.0,
            "last_trigger": "initial",
            "manual_mode": None,
            "manual_until": 0.0,
            "aftercare_pending": False,
            "callbacks": [],
            "last_proactive_at": 0.0,
            "proactive_day": "",
            "proactive_count": 0,
        }

    def _normalize(self, raw: dict[str, Any] | None, now: float) -> dict[str, Any]:
        state = self._default(now)
        if isinstance(raw, dict):
            state.update(raw)
        mood = str(state.get("mood") or "calm").strip().lower()
        state["mood"] = mood if mood in OWNER_MOODS else "calm"
        state["intensity"] = _clamp(state.get("intensity") or 0)
        state["expression"] = expression_for_mood(state["mood"])
        state["updated_at"] = float(state.get("updated_at") or now)
        state["last_owner_message_at"] = float(state.get("last_owner_message_at") or 0.0)
        state["last_proactive_at"] = float(state.get("last_proactive_at") or 0.0)
        state["manual_until"] = float(state.get("manual_until") or 0.0)
        callbacks = state.get("callbacks")
        state["callbacks"] = callbacks[-CALLBACK_LIMIT:] if isinstance(callbacks, list) else []
        return state

    def _timezone(self) -> ZoneInfo | timezone:
        try:
            return ZoneInfo(self.timezone_name)
        except ZoneInfoNotFoundError:
            return timezone.utc

    def _save(self) -> None:
        self._state["expression"] = expression_for_mood(str(self._state.get("mood") or "calm"))
        self.store.save_runtime_state(MOOD_STATE_KEY, self._state)

    def _apply_decay(self, now: float) -> bool:
        state = self._state
        elapsed = max(0.0, now - float(state.get("updated_at") or now))
        if elapsed < 60:
            return False

        manual_mode = str(state.get("manual_mode") or "").strip().lower()
        manual_until = float(state.get("manual_until") or 0.0)
        if manual_mode and manual_until <= now:
            manual_mode = ""
            state["manual_mode"] = None
            state["manual_until"] = 0.0

        decay_points = int(elapsed // (15 * 60)) * 2
        if decay_points <= 0:
            return False

        floor = 68 if manual_mode == "clingy" else 12
        intensity = max(floor, int(state.get("intensity") or 0) - decay_points)
        mood = str(state.get("mood") or "calm")

        if manual_mode == "clingy":
            mood = "clingy"
        elif manual_mode == "calm":
            mood = "calm"
            intensity = min(intensity, 20)
        elif mood in {"jealous", "sulky", "chaotic", "overwhelmed"} and intensity < 38:
            mood = "sweet"
        elif mood == "worried" and intensity < 30:
            mood = "calm"
        elif mood in {"sweet", "clingy", "shy"} and intensity < 20:
            mood = "calm"

        state["mood"] = mood
        state["intensity"] = intensity
        state["updated_at"] = now
        state["expression"] = expression_for_mood(mood)
        return True

    def _trim_callbacks(self, now: float) -> None:
        callbacks = [
            item
            for item in self._state.get("callbacks", [])
            if isinstance(item, dict) and now - float(item.get("at") or 0.0) <= CALLBACK_TTL_SECONDS
        ]
        self._state["callbacks"] = callbacks[-CALLBACK_LIMIT:]

    def _add_callback(self, trigger: str, message: str, now: float) -> None:
        callbacks = self._state.setdefault("callbacks", [])
        latest = callbacks[-1] if callbacks else None
        if isinstance(latest, dict) and latest.get("trigger") == trigger and now - float(latest.get("at") or 0.0) < 1800:
            latest["at"] = now
            latest["excerpt"] = _message_excerpt(message)
            return
        callbacks.append({"trigger": trigger, "excerpt": _message_excerpt(message), "at": now})
        del callbacks[:-CALLBACK_LIMIT]

    @staticmethod
    def _control_command(message: str) -> str | None:
        normalized = re.sub(r"\s+", " ", str(message or "")).strip().lower().rstrip(".!?")
        controls = {
            "lily mood": "status",
            "lily calm down": "calm",
            "lily tenang": "calm",
            "lily be clingy": "clingy",
            "lily clingy": "clingy",
            "lily normal": "normal",
        }
        return controls.get(normalized)

    def _control_reply(self, command: str, language: str) -> str:
        mood = str(self._state["mood"])
        intensity = int(self._state["intensity"])
        if language == "id":
            replies = {
                "status": f"Lily lagi {mood}, intensitas {intensity}/100. Puas sekarang udah ngecek isi hati Lily?",
                "calm": "Iya, iya. Lily tenang dulu. Tapi bukan berarti kamu bebas bikin ulah lagi, ya.",
                "clingy": "Baik. Sekarang jangan protes kalau Lily nempel terus dan nagih perhatianmu.",
                "normal": "Mode paksa dimatiin. Lily balik ngikutin perasaannya sendiri lagi.",
            }
        else:
            replies = {
                "status": f"Lily is feeling {mood}, intensity {intensity}/100. Happy now that you checked her heart?",
                "calm": "Fine, fine. Lily will calm down. That does not mean you get to cause trouble again.",
                "clingy": "All right. Do not complain when Lily stays close and demands your attention now.",
                "normal": "Forced mood is off. Lily will follow her own feelings again.",
            }
        return replies[command]

    def observe(self, message: str, *, source: str = "owner", now: float | None = None) -> dict[str, Any]:
        timestamp = float(now or time.time())
        language = _language(message)
        with self._lock:
            self._apply_decay(timestamp)
            self._trim_callbacks(timestamp)
            command = self._control_command(message)
            self._state["last_owner_message_at"] = timestamp
            self._state["updated_at"] = timestamp

            if command:
                if command == "calm":
                    self._state.update(
                        mood="calm",
                        intensity=12,
                        manual_mode="calm",
                        manual_until=timestamp + 2 * 3600,
                        aftercare_pending=False,
                        last_trigger="owner_control",
                    )
                elif command == "clingy":
                    self._state.update(
                        mood="clingy",
                        intensity=76,
                        manual_mode="clingy",
                        manual_until=timestamp + 6 * 3600,
                        aftercare_pending=False,
                        last_trigger="owner_control",
                    )
                elif command == "normal":
                    self._state.update(
                        mood="calm",
                        intensity=20,
                        manual_mode=None,
                        manual_until=0.0,
                        aftercare_pending=False,
                        last_trigger="owner_control",
                    )
                self._save()
                return {
                    "state": self.snapshot(now=timestamp),
                    "control": command,
                    "control_reply": self._control_reply(command, language),
                    "important": False,
                    "aftercare": False,
                    "source": source,
                }

            important = bool(_IMPORTANT_RE.search(message))
            previous_mood = str(self._state.get("mood") or "calm")
            trigger = "conversation"
            mood = previous_mood
            intensity = int(self._state.get("intensity") or 20)
            aftercare = False

            if _JEALOUS_RE.search(message):
                trigger, mood, intensity = "other_person", "jealous", max(intensity + 24, 76)
            elif _RISK_RE.search(message):
                trigger, mood, intensity = "careless_choice", "worried", max(intensity + 18, 64)
            elif _ABSENCE_RE.search(message):
                trigger, mood, intensity = "owner_absence", "sulky", max(intensity + 18, 62)
            elif _APPEASE_RE.search(message) and previous_mood in {"jealous", "sulky", "worried", "overwhelmed"}:
                trigger, mood, intensity = "reassured", "sweet", max(34, intensity - 28)
                aftercare = True
            elif _AFFECTION_RE.search(message):
                trigger = "owner_affection"
                mood = "clingy" if previous_mood in {"clingy", "sweet", "shy"} else "sweet"
                intensity = max(intensity + 12, 48)
                aftercare = previous_mood in {"jealous", "sulky", "worried", "overwhelmed"}
            elif _CHAOTIC_RE.search(message):
                trigger, mood, intensity = "chaotic_play", "chaotic", max(intensity + 10, 54)
            else:
                local_hour = datetime.fromtimestamp(timestamp, self._timezone()).hour
                if local_hour < 5:
                    trigger, mood, intensity = "late_night", "worried", max(intensity + 8, 48)

            manual_mode = str(self._state.get("manual_mode") or "").strip().lower()
            if manual_mode == "clingy" and trigger == "conversation":
                mood, intensity = "clingy", max(intensity, 68)
            elif manual_mode == "calm" and trigger == "conversation":
                mood, intensity = "calm", min(intensity, 20)

            if trigger != "conversation":
                self._add_callback(trigger, message, timestamp)

            self._state.update(
                mood=mood,
                intensity=_clamp(intensity),
                expression=expression_for_mood(mood),
                updated_at=timestamp,
                last_owner_message_at=timestamp,
                last_trigger=trigger,
                aftercare_pending=aftercare,
            )
            self._save()
            return {
                "state": self.snapshot(now=timestamp),
                "control": None,
                "control_reply": None,
                "important": important,
                "aftercare": aftercare,
                "source": source,
            }

    def snapshot(self, *, now: float | None = None) -> dict[str, Any]:
        timestamp = float(now or time.time())
        with self._lock:
            changed = self._apply_decay(timestamp)
            self._trim_callbacks(timestamp)
            if changed:
                self._save()
            state = dict(self._state)
            state["callbacks"] = [dict(item) for item in self._state.get("callbacks", [])]
            state["expression"] = expression_for_mood(str(state.get("mood") or "calm"))
            state["idle_seconds"] = (
                max(0, int(timestamp - float(state.get("last_owner_message_at") or 0.0)))
                if state.get("last_owner_message_at")
                else None
            )
            return state

    def prompt_context(self, state: dict[str, Any], *, important: bool = False, aftercare: bool = False) -> str:
        intensity = int(state.get("intensity") or 0)
        effective_intensity = min(intensity, 28) if important else intensity
        callbacks = [
            f"- {item.get('trigger')}: {item.get('excerpt')}"
            for item in state.get("callbacks", [])[-3:]
            if isinstance(item, dict) and item.get("excerpt")
        ]
        lines = [
            "Persistent owner mood context:",
            f"- Mood: {state.get('mood', 'calm')}",
            f"- Intensity: {effective_intensity}/100",
            f"- Hidden visual expression state: {state.get('expression', 'Blush')}. "
            "This is control metadata; never mention expressions, presets, JSON, or Live2D in the reply.",
            "- Let the mood color wording naturally; do not announce a mood label or intensity unless asked.",
        ]
        if important:
            lines.append(
                "- This is an important or operational conversation. Keep the reply precise, calm, and unambiguous; "
                "personality may color one short phrase but must not obstruct the answer."
            )
        if aftercare or state.get("aftercare_pending"):
            lines.append(
                "- Aftercare transition is active: soften after the emotional beat and briefly make sure the owner is okay."
            )
        if callbacks:
            lines.append("- Recent emotional callbacks are private owner-only context. Refer to at most one when natural:")
            lines.extend(callbacks)
        return "\n".join(lines)

    def claim_proactive(
        self,
        *,
        profile: str,
        min_idle_seconds: int,
        cooldown_seconds: int,
        max_per_day: int,
        now: float | None = None,
    ) -> dict[str, Any]:
        timestamp = float(now or time.time())
        with self._lock:
            state = self.snapshot(now=timestamp)
            if profile != "public":
                return {"due": False, "reason": "public_profile_required", "state": state}
            last_owner = float(state.get("last_owner_message_at") or 0.0)
            if not last_owner:
                return {"due": False, "reason": "no_owner_activity", "state": state}
            if timestamp - last_owner < max(60, min_idle_seconds):
                return {"due": False, "reason": "owner_recently_active", "state": state}
            last_proactive = float(state.get("last_proactive_at") or 0.0)
            if last_proactive and timestamp - last_proactive < max(60, cooldown_seconds):
                return {"due": False, "reason": "cooldown", "state": state}

            day = datetime.fromtimestamp(timestamp, self._timezone()).date().isoformat()
            count = int(state.get("proactive_count") or 0) if state.get("proactive_day") == day else 0
            if count >= max(1, max_per_day):
                return {"due": False, "reason": "daily_limit", "state": state}

            self._state["last_proactive_at"] = timestamp
            self._state["proactive_day"] = day
            self._state["proactive_count"] = count + 1
            self._state["updated_at"] = timestamp
            self._save()
            return {
                "due": True,
                "reason": "owner_idle",
                "claimed_at": timestamp,
                "state": self.snapshot(now=timestamp),
            }

    def release_proactive_claim(self, claimed_at: float) -> None:
        with self._lock:
            if abs(float(self._state.get("last_proactive_at") or 0.0) - float(claimed_at or 0.0)) > 1:
                return
            self._state["last_proactive_at"] = 0.0
            self._state["proactive_count"] = max(0, int(self._state.get("proactive_count") or 1) - 1)
            self._save()

    def consume_aftercare(self) -> None:
        with self._lock:
            if not self._state.get("aftercare_pending"):
                return
            self._state["aftercare_pending"] = False
            self._save()
