import logging
import os
from collections.abc import Callable
from typing import TypeVar

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .schemas import (
    DeviceControlRequest,
    DeviceControlResponse,
    DeviceListResponse,
    DeviceStateResponse,
    HealthResponse,
    HomeDevice,
    SceneActivationResponse,
    SceneActivateRequest,
    SceneDetail,
    SceneInfo,
    SceneListResponse,
    SceneUpsertRequest,
    WizDiscoveryRequest,
    WizDiscoveryResponse,
)
from .scenes import SceneStore
from .network_security import require_token_for_non_loopback
from .settings import HomeDeviceConfig, normalize_device_id, settings
from .state import HomeStateTracker
from .wiz import (
    HomeVesselError,
    WizClient,
    WizHostResolver,
    discover_wiz_devices,
    normalize_wiz_state,
    validate_rgb,
)


LOGGER = logging.getLogger(__name__)
WizOperationResult = TypeVar("WizOperationResult")


def _cors_allow_origins() -> list[str]:
    raw_origins = os.getenv(
        "LILY_HOME_CORS_ALLOW_ORIGINS",
        os.getenv("LILY_CORS_ALLOW_ORIGINS", ""),
    ).strip()
    environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
    development = environment in {"development", "dev", "local"}
    if not raw_origins:
        return ["*"] if development else []
    if raw_origins == "*":
        return ["*"] if development else []
    return [origin.strip().rstrip("/") for origin in raw_origins.split(",") if origin.strip()]


def _require_token(
    authorization: str | None = Header(default=None),
    x_lily_home_token: str | None = Header(default=None),
) -> None:
    if not settings.token:
        environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
        if environment not in {"development", "dev", "local"}:
            raise HTTPException(status_code=503, detail="Home Vessel service token is not configured.")
        return
    bearer = ""
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization.split(" ", 1)[1].strip()
    if x_lily_home_token == settings.token or bearer == settings.token:
        return
    raise HTTPException(status_code=401, detail="Missing or invalid Home Vessel token.")


app = FastAPI(title="Lily Home Vessel", version="0.1.0")

# Report the build actually loaded by this service, independently of later file updates.
import runpy as _runtime_runpy
from pathlib import Path as _RuntimePath
_runtime_runpy.run_path(str(_RuntimePath(__file__).resolve().parents[2] / "scripts" / "runtime_status.py"))["install_tracking"](app, "home_vessel")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
scene_store = SceneStore(settings.scene_store_path, settings.scenes)
state_tracker = HomeStateTracker(settings.offline_failure_threshold)
wiz_resolver = WizHostResolver(
    devices=settings.devices,
    cache_path=settings.wiz_host_cache_path,
    broadcast_space=settings.wiz_discovery_broadcast,
    port=settings.wiz_port,
    discovery_timeout_seconds=settings.wiz_discovery_timeout_seconds,
    recovery_timeout_seconds=settings.wiz_recovery_discovery_timeout_seconds,
    cooldown_seconds=settings.wiz_discovery_cooldown_seconds,
    enabled=settings.wiz_auto_discovery_enabled,
)


@app.on_event("startup")
def resolve_wiz_hosts_on_startup() -> None:
    require_token_for_non_loopback(settings.host, settings.token, "Home Vessel")
    try:
        wiz_resolver.refresh(force=True)
    except HomeVesselError as error:
        LOGGER.warning("WiZ startup discovery was unavailable: %s", error.detail)


@app.exception_handler(HomeVesselError)
async def home_vessel_error_handler(_request, error: HomeVesselError):
    return JSONResponse(status_code=error.status_code, content={"detail": error.detail})


def _device_to_payload(device: HomeDeviceConfig) -> HomeDevice:
    return HomeDevice(
        id=device.id,
        provider=device.provider,
        kind=device.kind,
        name=device.name,
        room=device.room,
        host=wiz_resolver.resolve_host(device) if device.provider == "wiz" else device.host,
        port=device.port,
        aliases=list(device.aliases),
    )


def _device_lookup() -> dict[str, HomeDeviceConfig]:
    devices: dict[str, HomeDeviceConfig] = {}
    for device in settings.devices:
        devices[device.id] = device
        for alias in device.aliases:
            normalized = normalize_device_id(alias)
            if normalized:
                devices.setdefault(normalized, device)
    return devices


def _get_device(device_id: str) -> HomeDeviceConfig:
    normalized = normalize_device_id(device_id)
    device = _device_lookup().get(normalized)
    if not device:
        raise HTTPException(status_code=404, detail="Home device was not found.")
    return device


def _wiz_client(device: HomeDeviceConfig, host: str | None = None) -> WizClient:
    return WizClient(host or wiz_resolver.resolve_host(device), device.port, settings.wiz_timeout_seconds)


def _run_wiz_operation(
    device: HomeDeviceConfig,
    operation: Callable[[WizClient], WizOperationResult],
) -> WizOperationResult:
    initial_host = wiz_resolver.resolve_host(device)
    try:
        return operation(_wiz_client(device, initial_host))
    except HomeVesselError as error:
        if error.status_code not in {502, 504} or not settings.wiz_auto_discovery_enabled:
            raise
        recovered_host = wiz_resolver.refresh_device(device)
        if recovered_host == initial_host:
            raise
        return operation(_wiz_client(device, recovered_host))


def _get_state(device: HomeDeviceConfig) -> DeviceStateResponse:
    if device.provider != "wiz":
        raise HomeVesselError(f"Unsupported home provider: {device.provider}", 501)
    try:
        payload = _run_wiz_operation(device, lambda client: client.get_pilot())
    except HomeVesselError:
        return DeviceStateResponse(**state_tracker.failure(device.id, device.provider))
    normalized = normalize_wiz_state(device.id, device.provider, payload)
    return DeviceStateResponse(**state_tracker.success(device.id, device.provider, normalized))


def _apply_control(device: HomeDeviceConfig, request: DeviceControlRequest) -> DeviceControlResponse:
    validate_rgb(request.rgb)
    if device.provider != "wiz":
        raise HomeVesselError(f"Unsupported home provider: {device.provider}", 501)
    if request.dry_run:
        return DeviceControlResponse(
            ok=True,
            device_id=device.id,
            provider=device.provider,
            dry_run=True,
            detail="Home device control was validated but not sent.",
            requested=request,
        )
    _run_wiz_operation(device, lambda client: client.set_state(request))
    return DeviceControlResponse(
        ok=True,
        device_id=device.id,
        provider=device.provider,
        dry_run=False,
        detail="Home device control was sent.",
        requested=request,
        state=_get_state(device),
    )


@app.get("/api/auth/check")
def credential_check(x_lily_token: str | None = Header(default=None)) -> dict:
    """Cheap authenticated probe for credential rotation; never runs a model."""
    import hmac
    if not settings.token or not hmac.compare_digest(x_lily_token or "", settings.token):
        raise HTTPException(status_code=401, detail="Invalid service credential")
    return {"authenticated": True, "service": "home"}


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    if settings.devices:
        status = "ok"
        detail = "Home Vessel is ready."
    else:
        status = "degraded"
        detail = "No home devices are configured."
    return HealthResponse(
        status=status,
        service="lily_home_vessel",
        detail=detail,
    )


@app.get("/api/home/devices", response_model=DeviceListResponse)
def list_devices(_auth: None = Depends(_require_token)) -> DeviceListResponse:
    return DeviceListResponse(devices=[_device_to_payload(device) for device in settings.devices])


@app.get("/api/home/devices/{device_id}/state", response_model=DeviceStateResponse)
def get_device_state(device_id: str, _auth: None = Depends(_require_token)) -> DeviceStateResponse:
    return _get_state(_get_device(device_id))


@app.post("/api/home/devices/{device_id}/state", response_model=DeviceControlResponse)
def control_device(
    device_id: str,
    request: DeviceControlRequest,
    _auth: None = Depends(_require_token),
) -> DeviceControlResponse:
    return _apply_control(_get_device(device_id), request)


@app.get("/api/home/scenes", response_model=SceneListResponse)
def list_scenes(_auth: None = Depends(_require_token)) -> SceneListResponse:
    return SceneListResponse(scenes=[SceneInfo(**scene.model_dump(exclude={"actions"})) for scene in scene_store.list()])


@app.get("/api/home/scenes/{scene_id}", response_model=SceneDetail)
def get_scene(scene_id: str, _auth: None = Depends(_require_token)) -> SceneDetail:
    scene = scene_store.get(scene_id)
    if not scene:
        raise HTTPException(status_code=404, detail="Home scene was not found.")
    return scene


@app.put("/api/home/scenes/{scene_id}", response_model=SceneDetail)
def put_scene(
    scene_id: str,
    request: SceneUpsertRequest,
    _auth: None = Depends(_require_token),
) -> SceneDetail:
    for action in request.actions:
        _get_device(action.device)
    try:
        return scene_store.upsert(scene_id, request)
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.delete("/api/home/scenes/{scene_id}")
def delete_scene(scene_id: str, _auth: None = Depends(_require_token)) -> dict[str, object]:
    try:
        removed = scene_store.delete(scene_id)
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if not removed:
        raise HTTPException(status_code=404, detail="Home scene was not found.")
    return {"ok": True, "scene_id": normalize_device_id(scene_id)}


@app.post("/api/home/scenes/{scene_id}/activate", response_model=SceneActivationResponse)
def activate_scene(
    scene_id: str,
    request: SceneActivateRequest | None = None,
    _auth: None = Depends(_require_token),
) -> SceneActivationResponse:
    normalized_scene = normalize_device_id(scene_id)
    scene = scene_store.get(normalized_scene)
    if not scene:
        raise HTTPException(status_code=404, detail="Home scene was not found.")

    results: list[DeviceControlResponse] = []
    dry_run = bool(request.dry_run) if request else False
    for action in scene.actions:
        device = _get_device(action.device)
        payload = action.model_dump(exclude={"device"}, exclude_none=True)
        payload.pop("device", None)
        payload["dry_run"] = dry_run or bool(payload.get("dry_run", False))
        results.append(_apply_control(device, DeviceControlRequest(**payload)))

    return SceneActivationResponse(
        ok=all(result.ok for result in results),
        scene_id=normalized_scene,
        dry_run=dry_run,
        results=results,
    )


@app.post("/api/home/discover/wiz", response_model=WizDiscoveryResponse)
def discover_wiz(
    request: WizDiscoveryRequest | None = None,
    _auth: None = Depends(_require_token),
) -> WizDiscoveryResponse:
    broadcast_space = (
        request.broadcast_space.strip()
        if request and request.broadcast_space.strip()
        else settings.wiz_discovery_broadcast
    )
    timeout_seconds = (
        request.timeout_seconds
        if request and request.timeout_seconds is not None
        else settings.wiz_discovery_timeout_seconds
    )
    return WizDiscoveryResponse(
        devices=discover_wiz_devices(
            broadcast_space=broadcast_space,
            timeout_seconds=timeout_seconds,
            port=settings.wiz_port,
        )
    )
