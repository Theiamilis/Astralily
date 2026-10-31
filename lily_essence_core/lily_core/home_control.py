import json
import os
import re
import time
from typing import Annotated, Any, Awaitable, Callable, Literal
from urllib.parse import quote

import requests
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .settings import settings


class HomeControlError(RuntimeError):
    def __init__(self, detail: str, status_code: int = 502) -> None:
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


class HomeCommandNotForHome(HomeControlError):
    pass


class HomeCommand(BaseModel):
    operation: Literal["status", "control"]
    state: Literal["on", "off", "toggle"] | None = None
    brightness: int | None = Field(default=None, ge=0, le=100)
    temperature_kelvin: int | None = Field(default=None, ge=1000, le=10000)
    rgb: list[int] | None = Field(default=None, min_length=3, max_length=3)
    all_devices: bool = False
    light_only: bool = True
    explicit_home_hint: bool = False

    @model_validator(mode="after")
    def validate_control_payload(self) -> "HomeCommand":
        if self.operation == "control" and all(
            value is None
            for value in (self.state, self.brightness, self.temperature_kelvin, self.rgb)
        ):
            raise ValueError("Home control requires at least one state value.")
        return self


class HomeExecutionResult(BaseModel):
    operation: Literal["status", "control"]
    devices: list[dict[str, Any]] = Field(default_factory=list)
    requested: dict[str, Any] = Field(default_factory=dict)


RgbChannel = Annotated[int, Field(ge=0, le=255)]


class HomePlanAction(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    device_id: str = Field(min_length=1, max_length=80)
    state: Literal["on", "off"] | None = None
    brightness: int | None = Field(default=None, ge=1, le=100)
    temperature_kelvin: int | None = Field(default=None, ge=2200, le=6500)
    rgb: list[RgbChannel] | None = Field(default=None, min_length=3, max_length=3)

    @model_validator(mode="after")
    def validate_action(self) -> "HomePlanAction":
        settings_values = (self.brightness, self.temperature_kelvin, self.rgb)
        if self.state is None and any(value is not None for value in settings_values):
            self.state = "on"
        if self.state == "off" and any(value is not None for value in settings_values):
            raise ValueError("An off action cannot include brightness or color settings.")
        if self.temperature_kelvin is not None and self.rgb is not None:
            raise ValueError("Choose either white temperature or RGB, not both.")
        if self.state is None and all(value is None for value in settings_values):
            raise ValueError("A planned action must change at least one supported field.")
        return self


class HomePlan(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    intent: Literal["apply", "not_home"] = "apply"
    confidence: float = Field(ge=0.0, le=1.0)
    summary: str = Field(default="", max_length=160)
    actions: list[HomePlanAction] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def validate_plan_intent(self) -> "HomePlan":
        if self.intent == "apply" and not self.actions:
            raise ValueError("An apply plan must include at least one action.")
        if self.intent == "not_home" and self.actions:
            raise ValueError("A not_home plan cannot include actions.")
        return self


class HomeDeviceControlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    state: Literal["on", "off", "toggle"] | None = None
    brightness: int | None = Field(default=None, ge=0, le=100)
    temperature_kelvin: int | None = Field(default=None, ge=1000, le=10000)
    rgb: list[RgbChannel] | None = Field(default=None, min_length=3, max_length=3)
    scene_id: int | None = Field(default=None, ge=1, le=35)
    speed: int | None = Field(default=None, ge=1, le=200)
    dry_run: bool = False

    @model_validator(mode="after")
    def validate_control(self) -> "HomeDeviceControlRequest":
        settings_values = (self.brightness, self.temperature_kelvin, self.rgb, self.scene_id, self.speed)
        if self.state is None and not any(value is not None for value in settings_values):
            raise ValueError("A home control request must change at least one supported field.")
        if self.state == "off" and any(value is not None for value in settings_values):
            raise ValueError("An off request cannot include light settings.")
        if self.temperature_kelvin is not None and self.rgb is not None:
            raise ValueError("Choose either white temperature or RGB, not both.")
        return self


class HomeSceneActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    device: str = Field(min_length=1, max_length=80)
    state: Literal["on", "off", "toggle"] | None = None
    brightness: int | None = Field(default=None, ge=0, le=100)
    temperature_kelvin: int | None = Field(default=None, ge=1000, le=10000)
    rgb: list[RgbChannel] | None = Field(default=None, min_length=3, max_length=3)
    scene_id: int | None = Field(default=None, ge=1, le=35)
    speed: int | None = Field(default=None, ge=1, le=200)

    @model_validator(mode="after")
    def validate_action(self) -> "HomeSceneActionRequest":
        values = (self.state, self.brightness, self.temperature_kelvin, self.rgb, self.scene_id, self.speed)
        if all(value is None for value in values):
            raise ValueError("A scene action must change at least one supported field.")
        if self.state == "off" and any(value is not None for value in values[1:]):
            raise ValueError("An off scene action cannot include light settings.")
        if self.temperature_kelvin is not None and self.rgb is not None:
            raise ValueError("Choose either white temperature or RGB, not both.")
        return self


class HomeSceneUpsertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=80)
    aliases: list[str] = Field(default_factory=list, max_length=12)
    actions: list[HomeSceneActionRequest] = Field(min_length=1, max_length=16)


_ON_RE = re.compile(r"\b(?:nyalain|nyalakan|hidupin|hidupkan|turn\s+on|switch\s+on)\b", re.I)
_OFF_RE = re.compile(r"\b(?:matiin|matikan|padamin|padamkan|turn\s+off|switch\s+off)\b", re.I)
_TOGGLE_RE = re.compile(r"\b(?:toggle|balik(?:in|kan)?\s+status)\b", re.I)
_STATUS_RE = re.compile(
    r"\b(?:cek|check|status|keadaan|kondisi|gimana|nyala\s+(?:ga|gak|nggak|enggak)|"
    r"mati\s+(?:ga|gak|nggak|enggak))\b|\b(?:nyala|mati)\s*[?]",
    re.I,
)
_HOME_HINT_RE = re.compile(
    r"\b(?:lampu|light|lights|wiz|teras|kamar|clairie\s+lab|smart\s+home|home\s+device|perangkat\s+rumah)\b",
    re.I,
)
_ALL_RE = re.compile(r"\b(?:semua|seluruh|all|every)\b", re.I)
_PERCENT_RE = re.compile(r"\b(100|[1-9]?\d)\s*(?:%|persen)\b", re.I)
_KELVIN_RE = re.compile(r"\b(1\d{3}|[2-9]\d{3}|10000)\s*k\b", re.I)
_CONTROL_CUE_RE = re.compile(r"\b(?:set|atur|ubah|ganti|jadi(?:in|kan)?|bikin|buat)\b", re.I)
_SEMANTIC_ACTION_RE = re.compile(
    r"\b(?:set|setting|atur|ubah|ganti|sesuai(?:in|kan)?|bikin|buatkan|jadi(?:in|kan)?|"
    r"nyalain|nyalakan|hidupin|hidupkan|turn\s+on|switch\s+on)\b",
    re.I,
)
_DARK_VISIBILITY_COMPLAINT_RE = re.compile(
    r"\b(?:kok|masih|terlalu|agak|ruangan(?:nya)?|kamar(?:nya)?|ini|di\s+sini|disini)\s+gelap\b|"
    r"\bgelap\s+(?:nih|banget|amat|ya|loh|dong|jir+)\b|"
    r"\b(?:kurang|gak|ga|nggak|enggak|tidak)\s+terang\b|"
    r"\b(?:too\s+dark|can(?:not|'t)\s+see)\b",
    re.I,
)
_EXPLICIT_DARK_AMBIENCE_RE = re.compile(
    r"\b(?:bikin|buat|set|atur|jadikan|jadiin|redupkan|redup\s+in|dim)\b.{0,50}\b(?:gelap|redup|dim)\b|"
    r"\b(?:gelap|redup|dim)\b.{0,30}\b(?:buat|untuk)\s+(?:tidur|nonton|movie|suasana|mood)\b",
    re.I,
)

_GENERIC_DEVICE_NAMES = {"home", "lampu", "light", "lights", "wiz", "device", "perangkat"}


def _normalize_text(value: object) -> str:
    text = str(value or "").strip().lower().replace("_", " ").replace("-", " ")
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_home_command(message: str) -> HomeCommand | None:
    text = str(message or "").strip()
    if not text:
        return None

    explicit_home_hint = bool(_HOME_HINT_RE.search(text))
    state: Literal["on", "off", "toggle"] | None = None
    operation: Literal["status", "control"] | None = None

    if _OFF_RE.search(text):
        operation, state = "control", "off"
    elif _ON_RE.search(text):
        operation, state = "control", "on"
    elif _TOGGLE_RE.search(text):
        operation, state = "control", "toggle"
    elif _STATUS_RE.search(text):
        operation = "status"

    percent_match = _PERCENT_RE.search(text)
    kelvin_match = _KELVIN_RE.search(text)
    brightness = int(percent_match.group(1)) if percent_match else None
    temperature_kelvin = int(kelvin_match.group(1)) if kelvin_match else None
    rgb: list[int] | None = None

    has_state_setting = any(value is not None for value in (brightness, temperature_kelvin, rgb))
    if operation is None and has_state_setting and (explicit_home_hint or _CONTROL_CUE_RE.search(text)):
        operation = "control"
    if operation is None:
        return None

    if operation == "control" and state is None and has_state_setting:
        state = "on"

    return HomeCommand(
        operation=operation,
        state=state,
        brightness=brightness,
        temperature_kelvin=temperature_kelvin,
        rgb=rgb,
        all_devices=bool(_ALL_RE.search(text)),
        light_only=bool(re.search(r"\b(?:lampu|light|lights)\b", text, re.I)),
        explicit_home_hint=explicit_home_hint,
    )


def _device_names(device: dict[str, Any]) -> list[str]:
    values = [device.get("id"), device.get("name"), device.get("room"), *(device.get("aliases") or [])]
    names = {_normalize_text(value) for value in values}
    return sorted((name for name in names if name and name not in _GENERIC_DEVICE_NAMES), key=len, reverse=True)


def _contains_name(message: str, name: str) -> bool:
    return bool(re.search(rf"(?:^|\b){re.escape(name)}(?:\b|$)", message, re.I))


def match_home_devices(message: str, devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized_message = _normalize_text(message)
    matches: list[tuple[int, dict[str, Any]]] = []
    for device in devices:
        matched_names = [name for name in _device_names(device) if _contains_name(normalized_message, name)]
        if matched_names:
            matches.append((len(matched_names[0]), device))
    matches.sort(key=lambda item: item[0], reverse=True)
    return [device for _name_length, device in matches]


def resolve_home_devices(message: str, command: HomeCommand, devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if command.all_devices:
        selected = [device for device in devices if not command.light_only or device.get("kind") == "light"]
        if selected:
            return selected
        raise HomeControlError("Tidak ada perangkat rumah yang cocok dengan perintah itu.", 404)

    matches = match_home_devices(message, devices)
    if matches:
        return [matches[0]]
    if len(devices) == 1 and command.explicit_home_hint:
        return devices
    if not command.explicit_home_hint:
        raise HomeCommandNotForHome("The command did not target a configured home device.", 404)
    available = ", ".join(str(device.get("name") or device.get("id")) for device in devices)
    detail = "Lampunya belum ketemu."
    if available:
        detail += f" Coba sebut {available}."
    raise HomeControlError(detail, 404)


def is_home_planning_candidate(message: str) -> bool:
    text = str(message or "").strip()
    return bool(
        text
        and _HOME_HINT_RE.search(text)
        and _SEMANTIC_ACTION_RE.search(text)
    )


def select_home_plan_targets(message: str, devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if _ALL_RE.search(message):
        selected = [device for device in devices if device.get("kind") == "light"]
    else:
        selected = match_home_devices(message, devices)

    if selected:
        return selected
    if len(devices) == 1:
        return devices

    available = ", ".join(str(device.get("name") or device.get("id")) for device in devices)
    detail = "Sebut lampu yang mau diatur dulu."
    if available:
        detail += f" Pilihannya: {available}."
    raise HomeControlError(detail, 422)


def select_home_context_targets(
    message: str,
    devices: list[dict[str, Any]],
    context: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    matches = match_home_devices(message, devices)
    if matches or _ALL_RE.search(message):
        return select_home_plan_targets(message, devices)

    target_ids = context.get("target_ids") if isinstance(context, dict) else None
    if isinstance(target_ids, list):
        wanted = {str(device_id) for device_id in target_ids}
        selected = [device for device in devices if str(device.get("id") or "") in wanted]
        if selected:
            return selected
    return select_home_plan_targets(message, devices)


def recent_home_context(session: dict[str, Any], ttl_seconds: float = 600.0) -> dict[str, Any] | None:
    context = session.get("home_context") if isinstance(session, dict) else None
    if not isinstance(context, dict):
        return None
    updated_at = float(context.get("updated_at") or 0.0)
    if not updated_at or time.time() - updated_at > max(1.0, float(ttl_seconds)):
        return None
    target_ids = context.get("target_ids")
    return context if isinstance(target_ids, list) and target_ids else None


def _extract_json_object(text: str) -> dict[str, Any] | None:
    raw = str(text or "").strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        payload = json.loads(raw[start : end + 1])
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


def validate_home_plan(
    payload: dict[str, Any] | None,
    targets: list[dict[str, Any]],
    min_confidence: float,
) -> HomePlan:
    if not payload:
        raise HomeControlError("Home planner tidak mengirim rencana yang valid.", 502)
    try:
        plan = HomePlan.model_validate(payload)
    except ValidationError as error:
        raise HomeControlError("Home planner mengirim pengaturan yang tidak valid.", 422) from error

    if plan.intent == "not_home":
        raise HomeCommandNotForHome("The message is not a smart-home follow-up.", 404)

    expected_ids = [str(device.get("id") or "").strip() for device in targets]
    planned_ids = [action.device_id for action in plan.actions]
    if len(planned_ids) != len(set(planned_ids)):
        raise HomeControlError("Home planner mengulang perangkat yang sama.", 422)
    if set(planned_ids) != set(expected_ids):
        raise HomeControlError("Home planner mencoba memakai target yang berbeda.", 422)
    if plan.confidence < max(0.0, min(1.0, float(min_confidence))):
        raise HomeControlError("Home planner belum cukup yakin dengan suasana yang diminta.", 422)
    return plan


def _home_planner_prompt(
    message: str,
    targets: list[dict[str, Any]],
    context: dict[str, Any] | None = None,
) -> str:
    safe_devices = [
        {
            "id": str(device.get("id") or ""),
            "name": str(device.get("name") or ""),
            "room": str(device.get("room") or ""),
            "kind": str(device.get("kind") or ""),
            "aliases": [str(alias) for alias in (device.get("aliases") or [])],
        }
        for device in targets
    ]
    return (
        "Plan a comfortable smart-light setting for the owner's request. Return exactly one JSON object and no markdown.\n"
        "Schema: {\"intent\":\"apply\",\"confidence\":0.0,\"summary\":\"short label\",\"actions\":[{\"device_id\":\"id\"," 
        "\"state\":\"on\",\"brightness\":25,\"temperature_kelvin\":2700,\"rgb\":null}]}\n"
        "If the request is unrelated to controlling these devices, return "
        "{\"intent\":\"not_home\",\"confidence\":1.0,\"summary\":\"not home\",\"actions\":[]}. "
        "Use every supplied device exactly once and never invent an ID. Allowed state values are on or off. "
        "Brightness is 1-100. White temperature is 2200-6500 K. RGB is three integers from 0-255. "
        "Use RGB for chromatic named colors and white temperature for shades of white. "
        "Use either temperature_kelvin or rgb, never both. Prefer conservative comfortable brightness. "
        "A complaint that the room is dark, too dark, hard to see, or 'gelap nih' is a visibility request: turn the "
        "selected light on and raise brightness noticeably. Never make a light dimmer for a darkness complaint. "
        "Only create a dim or dark ambience when the owner explicitly asks to dim the light or names a mood such as "
        "sleep, movie, or cozy. "
        "For watching movies prefer dim warm white; sleep should be very dim and warm; focus should be brighter neutral white. "
        "Do not include unsupported fields, prose, schedules, or device discovery.\n"
        f"Devices: {json.dumps(safe_devices, ensure_ascii=True)}\n"
        f"Recent context: {json.dumps(context or {}, ensure_ascii=True)}\n"
        f"Owner request: {json.dumps(message or '', ensure_ascii=True)}"
    )


PlannerCallable = Callable[..., Awaitable[str]]


def _apply_visibility_guard(
    message: str,
    plan: HomePlan,
    context: dict[str, Any] | None,
) -> HomePlan:
    normalized_message = str(message or "")
    if (
        _EXPLICIT_DARK_AMBIENCE_RE.search(normalized_message)
        or not _DARK_VISIBILITY_COMPLAINT_RE.search(normalized_message)
    ):
        return plan

    current_states = context.get("current_states") if isinstance(context, dict) else {}
    if not isinstance(current_states, dict):
        current_states = {}

    for action in plan.actions:
        current = current_states.get(action.device_id)
        current = current if isinstance(current, dict) else {}
        current_is_on = current.get("state") is True
        try:
            current_brightness = int(current.get("brightness")) if current_is_on else 0
        except (TypeError, ValueError):
            current_brightness = 0
        target_floor = min(100, max(65, current_brightness + 20))
        action.state = "on"
        action.brightness = max(int(action.brightness or 0), target_floor)

    plan.summary = "visibility boost"
    return plan


async def plan_home_ambience(
    message: str,
    targets: list[dict[str, Any]],
    planner: PlannerCallable,
    min_confidence: float,
    context: dict[str, Any] | None = None,
) -> HomePlan:
    prompt = _home_planner_prompt(message, targets, context)
    last_error: Exception | None = None
    for attempt in range(2):
        correction = ""
        if attempt and isinstance(last_error, HomeControlError):
            correction = (
                "\nYour previous response was rejected by the schema validator: "
                f"{last_error.detail} Return a corrected JSON object only."
            )
        try:
            raw = await planner(
                prompt + correction,
                "You are a strict smart-light planner. Return JSON only.",
                {"session_id": "home-planner", "mode": "owner_home"},
                max_tokens=320,
                temperature=0.0,
            )
            plan = validate_home_plan(_extract_json_object(raw), targets, min_confidence)
            return _apply_visibility_guard(message, plan, context)
        except HomeCommandNotForHome:
            raise
        except Exception as error:
            last_error = error

    if isinstance(last_error, HomeControlError):
        raise last_error
    raise HomeControlError("Home planner sedang tidak bisa dihubungi. Coba lagi sebentar.", 503) from last_error


class HomeVesselClient:
    def __init__(self, base_url: str, token: str = "", timeout_seconds: float = 4.0) -> None:
        self.base_url = base_url.strip().rstrip("/")
        self.token = token.strip()
        self.timeout_seconds = max(0.5, float(timeout_seconds))

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.base_url:
            raise HomeControlError("Home Vessel belum dikonfigurasi di Lily Core.", 503)

        url = f"{self.base_url}{path}"
        for attempt in range(2):
            try:
                response = requests.request(
                    method,
                    url,
                    headers=self._headers(),
                    json=payload,
                    timeout=self.timeout_seconds,
                )
            except requests.RequestException as error:
                if attempt == 0:
                    time.sleep(0.15)
                    continue
                raise HomeControlError(f"Home Vessel tidak bisa dihubungi: {str(error)[:120]}", 503) from error

            if response.status_code in {502, 504} and attempt == 0:
                time.sleep(0.15)
                continue
            if response.status_code >= 400:
                try:
                    detail = str(response.json().get("detail") or "").strip()
                except (TypeError, ValueError):
                    detail = ""
                if response.status_code == 401:
                    detail = "Token Home Vessel di Lily Core belum cocok."
                raise HomeControlError(detail or "Home Vessel menolak perintah.", response.status_code)
            try:
                data = response.json()
            except ValueError as error:
                raise HomeControlError("Home Vessel mengirim respons yang tidak valid.", 502) from error
            if not isinstance(data, dict):
                raise HomeControlError("Home Vessel mengirim respons yang tidak valid.", 502)
            return data

        raise HomeControlError("Home Vessel tidak merespons.", 504)

    def list_devices(self) -> list[dict[str, Any]]:
        payload = self._request("GET", "/api/home/devices")
        devices = payload.get("devices")
        return [device for device in devices if isinstance(device, dict)] if isinstance(devices, list) else []

    def get_state(self, device_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/home/devices/{quote(device_id, safe='')}/state")

    def set_state(self, device_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"/api/home/devices/{quote(device_id, safe='')}/state", payload)

    def list_scenes(self) -> list[dict[str, Any]]:
        payload = self._request("GET", "/api/home/scenes")
        scenes = payload.get("scenes")
        return [scene for scene in scenes if isinstance(scene, dict)] if isinstance(scenes, list) else []

    def get_scene(self, scene_id: str) -> dict[str, Any]:
        return self._request("GET", f"/api/home/scenes/{quote(scene_id, safe='')}")

    def put_scene(self, scene_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("PUT", f"/api/home/scenes/{quote(scene_id, safe='')}", payload)

    def delete_scene(self, scene_id: str) -> dict[str, Any]:
        return self._request("DELETE", f"/api/home/scenes/{quote(scene_id, safe='')}")

    def activate_scene(self, scene_id: str, dry_run: bool = False) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/api/home/scenes/{quote(scene_id, safe='')}/activate",
            {"dry_run": bool(dry_run)},
        )


def sanitize_home_device(device: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(device.get("id") or ""),
        "provider": str(device.get("provider") or ""),
        "kind": str(device.get("kind") or "device"),
        "name": str(device.get("name") or device.get("id") or "Home device"),
        "room": str(device.get("room") or ""),
        "aliases": [str(alias) for alias in (device.get("aliases") or [])],
    }


def sanitize_home_state(state: dict[str, Any]) -> dict[str, Any]:
    allowed = (
        "device_id",
        "provider",
        "online",
        "connection",
        "last_seen",
        "consecutive_failures",
        "state",
        "brightness",
        "temperature_kelvin",
        "rgb",
        "scene_id",
    )
    return {key: state.get(key) for key in allowed if key in state}


def sanitize_home_scene(scene: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "id": str(scene.get("id") or scene.get("scene_id") or ""),
        "name": str(scene.get("name") or scene.get("id") or "Scene"),
        "aliases": [str(alias) for alias in (scene.get("aliases") or [])],
        "action_count": int(scene.get("action_count") or len(scene.get("actions") or [])),
        "source": str(scene.get("source") or "user"),
        "read_only": bool(scene.get("read_only", False)),
    }
    if isinstance(scene.get("actions"), list):
        payload["actions"] = [
            {
                key: value
                for key, value in action.items()
                if key in {"device", "state", "brightness", "temperature_kelvin", "rgb", "scene_id", "speed"}
            }
            for action in scene["actions"]
            if isinstance(action, dict)
        ]
    return payload


def create_home_client() -> HomeVesselClient:
    return HomeVesselClient(
        getattr(settings, "home_vessel_url", os.getenv("LILY_HOME_VESSEL_URL", "http://127.0.0.1:10896")),
        getattr(settings, "home_vessel_token", os.getenv("LILY_HOME_VESSEL_TOKEN", "")),
        getattr(settings, "home_vessel_timeout_seconds", os.getenv("LILY_HOME_VESSEL_TIMEOUT_SECONDS", "4.0")),
    )


def home_planner_enabled() -> bool:
    raw = str(getattr(settings, "home_planner_enabled", os.getenv("LILY_HOME_PLANNER_ENABLED", "true")))
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def home_planner_timeout_seconds() -> float:
    return max(
        1.0,
        float(getattr(settings, "home_planner_timeout_seconds", os.getenv("LILY_HOME_PLANNER_TIMEOUT_SECONDS", "8.0"))),
    )


def home_planner_min_confidence() -> float:
    return min(
        1.0,
        max(
            0.0,
            float(getattr(settings, "home_planner_min_confidence", os.getenv("LILY_HOME_PLANNER_MIN_CONFIDENCE", "0.75"))),
        ),
    )


def _control_payload(command: HomeCommand) -> dict[str, Any]:
    return {
        key: value
        for key, value in {
            "state": command.state,
            "brightness": command.brightness,
            "temperature_kelvin": command.temperature_kelvin,
            "rgb": command.rgb,
        }.items()
        if value is not None
    }


def _preview_state(current: dict[str, Any], requested: dict[str, Any]) -> dict[str, Any]:
    state = dict(current or {})
    requested_state = requested.get("state")
    if requested_state == "on":
        state["state"] = True
    elif requested_state == "off":
        state["state"] = False
    elif requested_state == "toggle":
        state["state"] = not bool(state.get("state"))
    for key in ("brightness", "temperature_kelvin", "rgb"):
        if key in requested:
            state[key] = requested[key]
    return state


def preview_home_command(
    message: str,
    command: HomeCommand,
    devices: list[dict[str, Any]],
    current_states: dict[str, dict[str, Any]] | None = None,
) -> HomeExecutionResult:
    selected = resolve_home_devices(message, command, devices)
    requested = _control_payload(command)
    states = current_states or {}
    return HomeExecutionResult(
        operation=command.operation,
        requested=requested,
        devices=[
            {
                "device": device,
                "state": _preview_state(states.get(str(device.get("id") or ""), {}), requested),
            }
            for device in selected
        ],
    )


def preview_home_plan(
    plan: HomePlan,
    devices: list[dict[str, Any]],
    current_states: dict[str, dict[str, Any]] | None = None,
) -> HomeExecutionResult:
    device_by_id = {str(device.get("id") or ""): device for device in devices}
    states = current_states or {}
    results: list[dict[str, Any]] = []
    planned_actions: list[dict[str, Any]] = []
    for action in plan.actions:
        device = device_by_id.get(action.device_id)
        if not device:
            raise HomeControlError("Home planner memilih perangkat yang tidak tersedia.", 422)
        payload = action.model_dump(exclude={"device_id"}, exclude_none=True)
        results.append(
            {
                "device": device,
                "state": _preview_state(states.get(action.device_id, {}), payload),
            }
        )
        planned_actions.append({"device_id": action.device_id, **payload})

    requested = (
        {key: value for key, value in planned_actions[0].items() if key != "device_id"}
        if len(planned_actions) == 1
        else {"planned_actions": planned_actions}
    )
    return HomeExecutionResult(operation="control", devices=results, requested=requested)


def execute_home_command(
    message: str,
    command: HomeCommand,
    client: HomeVesselClient | None = None,
    devices: list[dict[str, Any]] | None = None,
) -> HomeExecutionResult:
    home_client = client or create_home_client()
    available_devices = devices if devices is not None else home_client.list_devices()
    if not available_devices:
        raise HomeControlError("Belum ada perangkat yang terdaftar di Home Vessel.", 503)
    selected = resolve_home_devices(message, command, available_devices)

    results: list[dict[str, Any]] = []
    requested = _control_payload(command)
    for device in selected:
        device_id = str(device.get("id") or "").strip()
        if not device_id:
            continue
        if command.operation == "status":
            state = home_client.get_state(device_id)
        else:
            response = home_client.set_state(device_id, requested)
            state = response.get("state") if isinstance(response.get("state"), dict) else {}
        results.append({"device": device, "state": state})

    if not results:
        raise HomeControlError("Home Vessel tidak punya perangkat yang bisa dikontrol.", 503)
    return HomeExecutionResult(operation=command.operation, devices=results, requested=requested)


def execute_home_plan(
    plan: HomePlan,
    devices: list[dict[str, Any]],
    client: HomeVesselClient | None = None,
) -> HomeExecutionResult:
    home_client = client or create_home_client()
    device_by_id = {str(device.get("id") or ""): device for device in devices}
    results: list[dict[str, Any]] = []
    planned_actions: list[dict[str, Any]] = []

    for action in plan.actions:
        device = device_by_id.get(action.device_id)
        if not device:
            raise HomeControlError("Home planner memilih perangkat yang tidak tersedia.", 422)
        payload = action.model_dump(exclude={"device_id"}, exclude_none=True)
        response = home_client.set_state(action.device_id, payload)
        state = response.get("state") if isinstance(response.get("state"), dict) else {}
        results.append({"device": device, "state": state})
        planned_actions.append({"device_id": action.device_id, **payload})

    if not results:
        raise HomeControlError("Home planner tidak menghasilkan aksi yang bisa dijalankan.", 422)
    requested = (
        {key: value for key, value in planned_actions[0].items() if key != "device_id"}
        if len(planned_actions) == 1
        else {"planned_actions": planned_actions}
    )
    return HomeExecutionResult(operation="control", devices=results, requested=requested)


def format_home_result(result: HomeExecutionResult, language: str = "id") -> str:
    if str(language or "").strip().lower() in {"ja", "ja-jp", "japanese"}:
        parts = []
        for item in result.devices:
            device = item.get("device") or {}
            state = item.get("state") or {}
            name = str(device.get("name") or device.get("id") or "照明")
            if result.operation == "status":
                if state.get("online") is False:
                    parts.append(f"{name} はオフラインです。")
                    continue
                status = "点灯中" if state.get("state") is True else "消灯中" if state.get("state") is False else "状態不明"
                brightness = state.get("brightness")
                suffix = f" 明るさは{brightness}%です。" if brightness is not None else ""
                parts.append(f"{name} は{status}です。{suffix}")
            elif result.requested.get("state") == "off":
                parts.append(f"{name} を消しました。")
            elif result.requested.get("brightness") is not None:
                parts.append(f"{name} の明るさを{result.requested['brightness']}%に設定しました。")
            elif result.requested.get("rgb") is not None:
                parts.append(f"{name} の色を変更しました。")
            elif result.requested.get("temperature_kelvin") is not None:
                parts.append(f"{name} の色温度を変更しました。")
            elif result.requested.get("state") == "toggle":
                parts.append(f"{name} の点灯・消灯を切り替えました。")
            else:
                parts.append(f"{name} を設定しました。")
        return " ".join(parts)
    is_english = str(language or "").strip().lower() in {"en", "english"}
    if len(result.devices) > 1:
        if result.operation == "status":
            parts = []
            for item in result.devices:
                name = str(item["device"].get("name") or item["device"].get("id"))
                state = item.get("state") or {}
                if is_english:
                    state_text = "on" if state.get("state") is True else "off" if state.get("state") is False else "unknown"
                else:
                    state_text = "nyala" if state.get("state") is True else "mati" if state.get("state") is False else "tidak diketahui"
                parts.append(f"{name}: {state_text}")
            return ("Home status: " if is_english else "Status rumah: ") + ", ".join(parts) + "."
        if result.requested.get("state") == "off":
            return "All selected lights are off." if is_english else "Semua lampu yang dipilih sudah mati."
        return "All selected lights have been updated." if is_english else "Semua lampu yang dipilih sudah diatur."

    item = result.devices[0]
    device = item.get("device") or {}
    state = item.get("state") or {}
    name = str(device.get("name") or device.get("id") or "Home device")
    if result.operation == "status":
        if state.get("online") is False:
            return f"{name} is offline." if is_english else f"{name} sedang offline."
        if is_english:
            state_text = "on" if state.get("state") is True else "off" if state.get("state") is False else "unknown"
        else:
            state_text = "nyala" if state.get("state") is True else "mati" if state.get("state") is False else "tidak diketahui"
        brightness = state.get("brightness")
        suffix = f" at {brightness}%" if is_english and brightness is not None else f" di {brightness}%" if brightness is not None else ""
        return f"{name} is {state_text}{suffix}." if is_english else f"{name} sekarang {state_text}{suffix}."

    if result.requested.get("state") == "off":
        return f"{name} is off." if is_english else f"{name} sudah mati."
    brightness = result.requested.get("brightness")
    if brightness is not None:
        return f"{name} is on at {brightness}%." if is_english else f"{name} sudah nyala di {brightness}%."
    if result.requested.get("rgb") is not None:
        return f"{name}'s color has been updated." if is_english else f"Warna {name} sudah diubah."
    if result.requested.get("temperature_kelvin") is not None:
        return f"{name}'s white temperature has been updated." if is_english else f"Warna putih {name} sudah diatur."
    if result.requested.get("state") == "toggle":
        return f"{name} has been toggled." if is_english else f"Status {name} sudah dibalik."
    return f"{name} is on." if is_english else f"{name} sudah nyala."
