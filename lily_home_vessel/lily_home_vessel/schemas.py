from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


RgbChannel = Annotated[int, Field(ge=0, le=255)]


class HomeDevice(BaseModel):
    id: str
    provider: str
    kind: str
    name: str
    room: str = ""
    host: str
    port: int
    aliases: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    service: str
    detail: str


class DeviceListResponse(BaseModel):
    devices: list[HomeDevice]


class DeviceStateResponse(BaseModel):
    device_id: str
    provider: str
    online: bool
    connection: Literal["online", "reconnecting", "offline"] = "online"
    last_seen: str | None = None
    consecutive_failures: int = Field(default=0, ge=0)
    state: bool | None = None
    brightness: int | None = None
    temperature_kelvin: int | None = None
    rgb: list[int] | None = None
    scene_id: int | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class DeviceControlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: Literal["on", "off", "toggle"] | None = None
    brightness: int | None = Field(default=None, ge=0, le=100)
    temperature_kelvin: int | None = Field(default=None, ge=1000, le=10000)
    rgb: list[RgbChannel] | None = Field(default=None, min_length=3, max_length=3)
    scene_id: int | None = Field(default=None, ge=1, le=35)
    speed: int | None = Field(default=None, ge=1, le=200)
    dry_run: bool = False


class DeviceControlResponse(BaseModel):
    ok: bool
    device_id: str
    provider: str
    dry_run: bool
    detail: str
    requested: DeviceControlRequest
    state: DeviceStateResponse | None = None


class SceneAction(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    device: str = Field(min_length=1, max_length=80)
    state: Literal["on", "off", "toggle"] | None = None
    brightness: int | None = Field(default=None, ge=0, le=100)
    temperature_kelvin: int | None = Field(default=None, ge=1000, le=10000)
    rgb: list[RgbChannel] | None = Field(default=None, min_length=3, max_length=3)
    scene_id: int | None = Field(default=None, ge=1, le=35)
    speed: int | None = Field(default=None, ge=1, le=200)

    @model_validator(mode="after")
    def validate_action(self) -> "SceneAction":
        values = (self.state, self.brightness, self.temperature_kelvin, self.rgb, self.scene_id, self.speed)
        if all(value is None for value in values):
            raise ValueError("A scene action must change at least one supported field.")
        if self.state == "off" and any(value is not None for value in values[1:]):
            raise ValueError("An off scene action cannot include light settings.")
        if self.temperature_kelvin is not None and self.rgb is not None:
            raise ValueError("Choose either white temperature or RGB, not both.")
        return self


class SceneUpsertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=80)
    aliases: list[str] = Field(default_factory=list, max_length=12)
    actions: list[SceneAction] = Field(min_length=1, max_length=16)


class SceneInfo(BaseModel):
    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    action_count: int
    source: Literal["built_in", "user"]
    read_only: bool


class SceneDetail(SceneInfo):
    actions: list[SceneAction]


class SceneListResponse(BaseModel):
    scenes: list[SceneInfo]


class SceneActivateRequest(BaseModel):
    dry_run: bool = False


class SceneActivationResponse(BaseModel):
    ok: bool
    scene_id: str
    dry_run: bool
    results: list[DeviceControlResponse]


class WizDiscoveryRequest(BaseModel):
    broadcast_space: str = ""
    timeout_seconds: float | None = Field(default=None, ge=0.1, le=10.0)


class WizDiscoveredDevice(BaseModel):
    host: str
    port: int
    mac: str = ""
    state: bool | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class WizDiscoveryResponse(BaseModel):
    devices: list[WizDiscoveredDevice]
