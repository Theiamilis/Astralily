from typing import Literal

from pydantic import BaseModel, Field


class ToolArtifact(BaseModel):
    id: str
    name: str
    kind: str
    mime_type: str
    size_bytes: int = Field(default=0, ge=0)
    sha256: str = ""
    download_url: str = ""


class ToolRunRequest(BaseModel):
    task: str = Field(..., min_length=1)
    action: str = "research"
    source: str = "dashboard"
    requester: str = "owner"
    session_id: str = "owner-tools"
    risk: str = "read"
    provider: str | None = None
    timeout_seconds: int | None = Field(default=None, ge=10, le=3600)
    artifact_dir: str = ""
    input_dir: str = ""
    input_files: list[dict[str, object]] = Field(default_factory=list)


class ToolRunResponse(BaseModel):
    ok: bool
    status: str
    provider: str
    result_text: str = ""
    error: str = ""
    duration_ms: int = 0
    requested_provider: str = ""
    fallback_used: bool = False
    provider_attempts: list[dict[str, str]] = Field(default_factory=list)
    artifacts: list[ToolArtifact] = Field(default_factory=list)


DevicePowerAction = Literal["shutdown", "restart", "hibernate", "cancel"]


class DevicePowerRequest(BaseModel):
    target: str = Field(..., min_length=1, max_length=80)
    action: DevicePowerAction
    confirmed: Literal[True]
    source: str = Field(default="lily_core", max_length=80)
    reason: str = Field(default="Owner-confirmed Lily power action", max_length=240)


class DevicePowerResponse(BaseModel):
    ok: bool
    status: str
    target_id: str
    target_label: str
    action: DevicePowerAction
    detail: str = ""
    duration_ms: int = 0


class DevicePowerStatusRequest(BaseModel):
    target: str = Field(..., min_length=1, max_length=80)


class DevicePowerStatus(BaseModel):
    target_id: str
    target_label: str
    online: bool
    hostname: str = ""
    logged_in_user: str = ""
    uptime_seconds: int | None = None
    cpu_percent: float | None = None
    memory_used_bytes: int | None = None
    memory_total_bytes: int | None = None
    boot_time: str = ""
    checked_at: str
    latency_ms: int = 0
    detail: str = ""


class DevicePowerHistoryResponse(BaseModel):
    items: list[dict[str, object]] = Field(default_factory=list)
    count: int = 0


class DevicePowerWatcher(BaseModel):
    id: str
    target_id: str
    target_label: str
    action: DevicePowerAction
    state: str
    started_at: str
    updated_at: str
    detail: str = ""
