"""Owner-managed secretary configuration shared by launcher and personal WA."""
import hashlib
import json
import os
from pathlib import Path
import re
import threading
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

router = APIRouter()
LOCK = threading.RLock()


class ContactRule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    number: str = Field(min_length=8, max_length=30)
    label: str = Field(default="", max_length=80)
    action: Literal["ignore", "summary_only", "secretary"]

    @field_validator("number")
    @classmethod
    def normalize_number(cls, value: str) -> str:
        if re.search(r"[^+\d\s().-]", value):
            raise ValueError("Use a phone number, not a contact ID.")
        digits = re.sub(r"\D", "", value)
        if digits.startswith("00"):
            digits = digits[2:]
        if digits.startswith("0"):
            digits = "62" + digits[1:]
        if not 8 <= len(digits) <= 16:
            raise ValueError("Phone number must contain 8–16 digits.")
        return digits


class InboxNotifications(BaseModel):
    model_config = ConfigDict(extra="forbid")
    channels: list[Literal["wa", "mobile", "hud"]] = Field(default_factory=lambda: ["wa"], min_length=1, max_length=3)
    mode: Literal["immediate", "digest"] = "immediate"
    digest_minutes: int = Field(default=15, ge=1, le=1440)
    quiet_enabled: bool = False
    quiet_start: str = Field(default="22:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    quiet_end: str = Field(default="07:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    timezone: Literal["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Tokyo", "UTC"] = "Asia/Jakarta"
    urgent_immediate: bool = True

    @field_validator("channels")
    @classmethod
    def unique_channels(cls, value):
        return list(dict.fromkeys(value))


class SecretarySettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["off", "auto", "active"] = "off"
    default_action: Literal["summary_only", "secretary", "ignore"] = "summary_only"
    triage_mode: Literal["shadow", "enforce"] = "shadow"
    first_reply_seconds: int = Field(default=60, ge=5, le=1800)
    followup_seconds: int = Field(default=8, ge=2, le=120)
    handoff_minutes: int = Field(default=30, ge=1, le=1440)
    conversation_minutes: int = Field(default=15, ge=1, le=120)
    max_replies: int = Field(default=6, ge=1, le=20)
    per_contact_send_limit_per_hour: int = Field(default=6, ge=1, le=60)
    global_send_limit_per_hour: int = Field(default=30, ge=1, le=500)
    summary_delay_seconds: int = Field(default=30, ge=0, le=300)
    notifications: InboxNotifications = Field(default_factory=InboxNotifications)
    system_prompt: str = Field(default="", max_length=16000)
    contacts: list[ContactRule] = Field(default_factory=list, max_length=300)

    @model_validator(mode="after")
    def unique_contacts(self):
        if len({rule.number for rule in self.contacts}) != len(self.contacts):
            raise ValueError("Each number can have only one rule.")
        return self


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str
    settings: SecretarySettings


def settings_path() -> Path:
    return Path(os.getenv("LILY_SECRETARY_SETTINGS_PATH", str(Path(__file__).resolve().parents[1] / "runtime/secretary-settings.json")))


def read_settings() -> SecretarySettings:
    path = settings_path()
    if not path.exists():
        return SecretarySettings()
    return SecretarySettings.model_validate_json(path.read_text(encoding="utf-8"))


def revision(value: SecretarySettings) -> str:
    return hashlib.sha256(json.dumps(value.model_dump(), sort_keys=True).encode()).hexdigest()


@router.get("/api/wa/secretary/settings")
def settings_snapshot() -> dict:
    from .wa_secretary import SECRETARY_PROMPT
    try:
        with LOCK:
            value = read_settings()
        return {"settings": value.model_dump(), "revision": revision(value), "default_prompt": SECRETARY_PROMPT}
    except (OSError, ValueError):
        raise HTTPException(503, "Secretary settings are unavailable; automatic replies should remain off.") from None


@router.post("/api/wa/secretary/settings")
def save_settings(request: SettingsUpdate) -> dict:
    with LOCK:
        try:
            previous = read_settings()
            if revision(previous) != request.revision:
                raise HTTPException(409, "Settings changed elsewhere. Reload before saving.")
            path = settings_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(request.settings.model_dump_json(indent=2), encoding="utf-8")
            temporary.chmod(0o600)
            os.replace(temporary, path)
            return settings_snapshot()
        except (OSError, ValueError):
            raise HTTPException(503, "Secretary settings could not be saved.") from None
