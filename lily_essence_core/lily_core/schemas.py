import re
from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field, model_validator


SourceType = Literal["dashboard", "mobile_realm", "listener", "stream_stage", "wa_bridge", "tiktok_bridge", "system", "testing"]
ModeType = Literal[
    "language_practice",
    "owner_chat",
    "owner_tool",
    "public_chat",
    "gaming_companion",
    "coding_companion",
    "secretary",
    "passive_watch",
    "system_control",
]
ReplyTarget = Literal["dashboard", "mobile_realm", "listener", "stream_stage", "wa_bridge", "system"]


class IngestRequest(BaseModel):
    source: SourceType
    session_id: str = Field(..., min_length=1)
    mode: ModeType
    priority: Optional[int] = None
    timestamp: Optional[float] = None
    trace_id: Optional[str] = None
    payload: Dict[str, Any]

    @model_validator(mode="after")
    def validate_listener_session(self):
        if self.source == "listener":
            device = str(self.payload.get("device_id") or "")
            if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", device):
                raise ValueError("Listener requires a valid device_id.")
            if self.mode != "owner_chat" or not re.fullmatch(r"listener:" + re.escape(device) + r":[a-z0-9][a-z0-9_-]{0,39}", self.session_id):
                raise ValueError("Listener requires owner_chat and a device-scoped listener session.")
        return self


class CoreResult(BaseModel):
    ok: bool = True
    trace_id: Optional[str] = None
    session_id: str
    reply_target: ReplyTarget
    text: Optional[str] = None
    subtitle: Optional[str] = None
    emotion: Optional[str] = None
    expression: Optional[str] = None
    audio_url: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class IntentRouteRequest(BaseModel):
    source: str = "wa_bridge"
    session_id: str = Field(default="owner-router", min_length=1)
    message: str = ""
    reply_language: str = "id"
    context: Dict[str, Any] = Field(default_factory=dict)


class IntentRouteResult(BaseModel):
    ok: bool = True
    source: str = "core_router"
    domain: str = "chat"
    intent: str = "chat"
    confidence: float = 1.0
    reason: str = ""
    params: Dict[str, Any] = Field(default_factory=dict)
