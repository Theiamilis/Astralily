import asyncio
import hmac
import httpx
import json
import logging
import os
import time
from ipaddress import ip_address
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from fastapi import FastAPI, HTTPException, Query, Depends, File, Form, Header, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager

from datetime import datetime
from lily_core import core_service
from lily_core.openclaw_tools import (
    approve_openclaw_request,
    cancel_openclaw_request,
    create_openclaw_request,
    deny_openclaw_request,
    get_openclaw_artifact,
    get_openclaw_health,
    list_openclaw_deliveries,
    list_openclaw_requests,
    mark_openclaw_delivered,
    get_openclaw_maintenance,
    prune_openclaw_artifacts,
    release_openclaw_delivery,
    retry_openclaw_request,
)
from lily_core.intent_router import route_owner_intent
from lily_core.home_control import (
    HomeControlError,
    HomeDeviceControlRequest,
    HomeSceneUpsertRequest,
    create_home_client,
    sanitize_home_device,
    sanitize_home_scene,
    sanitize_home_state,
)
from lily_core.finance import (
    FinanceConfirmRequest,
    FinanceDraftCreate,
    FinanceInterpretRequest,
    FinanceProxyError,
    create_finance_client,
    encode_receipt,
    finance_drafts,
    public_account_payload,
    public_transaction_payload,
    transaction_from_upstream,
)
from lily_core.power import (
    DevicePowerError,
    WakePowerError,
    execute_target_wake_power,
    execute_wake_power,
    get_device_power_history,
    get_device_power_status,
    list_device_power_targets,
    verify_optional_wake_token,
)
from lily_core.schemas import IngestRequest, IntentRouteRequest
from lily_core.voice_capabilities import public_capabilities
from lily_core.settings import settings
from lily_core.state_store import core_state_store
from lily_core.providers import generate_voice_result, reset_provider_clients
from lily_core.screen_companion import router as screen_companion_router
from lily_core.runtime_settings import settings_snapshot, update_runtime_settings
from lily_core.audio_access import prune_core_audio_cache, verify_core_audio_url
from lily_core.http_security import (
    RequestBodyLimitMiddleware,
    SlidingWindowRateLimiter,
    actor_fingerprint,
    default_security_audit_log,
    new_request_id,
    rate_limit_bucket_path,
    rate_limit_for_request,
)
from fastapi.staticfiles import StaticFiles

load_dotenv()

logging.basicConfig(format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO)
logger = logging.getLogger(__name__)

CORE_DIR = Path(__file__).resolve().parent
STATIC_DIR = CORE_DIR / "static"
STATIC_AUDIO_DIR = STATIC_DIR / "audio"
STATIC_AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# Configure Async MongoDB Connection
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "chatbot_db")
MONGO_MIRROR_ENABLED = os.getenv("LILY_MONGO_MIRROR_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
client = AsyncIOMotorClient(MONGO_URI)
db = client[DB_NAME]

def get_database():
    return db

@asynccontextmanager
async def lifespan(app: FastAPI):
    normalized_host = settings.core_host.strip().lower().strip("[]")
    try:
        loopback = normalized_host == "localhost" or ip_address(normalized_host).is_loopback
    except ValueError:
        loopback = normalized_host == "localhost"
    if not loopback and (not settings.owner_api_token or not settings.owner_api_token_enforced):
        raise RuntimeError(
            "Essence Core refuses a non-loopback bind unless owner API authentication is configured and enforced."
        )
    await asyncio.to_thread(prune_core_audio_cache, STATIC_AUDIO_DIR, force=True)
    await asyncio.to_thread(family_store.prune_expired)
    family_retention_task = asyncio.create_task(_family_retention_loop())
    # Setup runs here before app starts
    try:
        yield
    finally:
        family_retention_task.cancel()
        try:
            await family_retention_task
        except asyncio.CancelledError:
            pass
    # Cleanup runs here on shutdown
    logger.info("Closing MongoDB connection.")
    client.close()

# FastAPI instance
app = FastAPI(lifespan=lifespan)

# Report the build actually loaded by this service, independently of later file updates.
import runpy as _runtime_runpy
from pathlib import Path as _RuntimePath
_runtime_runpy.run_path(str(_RuntimePath(__file__).resolve().parents[1] / "scripts" / "runtime_status.py"))["install_tracking"](app, "core")
app.include_router(screen_companion_router)

_HEALTH_CACHE_TTL_SECONDS = max(1.0, float(os.getenv("LILY_HEALTH_CACHE_TTL_SECONDS", "5.0")))
_health_cache: dict[str, Any] = {"state": None, "updated_at": 0.0}
_health_cache_lock = asyncio.Lock()
_health_refresh_task: asyncio.Task[dict[str, Any]] | None = None


async def _cached_core_state() -> dict[str, Any]:
    now = asyncio.get_running_loop().time()
    cached = _health_cache.get("state")
    if isinstance(cached, dict) and now - float(_health_cache.get("updated_at") or 0.0) < _HEALTH_CACHE_TTL_SECONDS:
        return cached

    async with _health_cache_lock:
        now = asyncio.get_running_loop().time()
        cached = _health_cache.get("state")
        if isinstance(cached, dict) and now - float(_health_cache.get("updated_at") or 0.0) < _HEALTH_CACHE_TTL_SECONDS:
            return cached
        state = await asyncio.to_thread(core_service.get_state)
        _health_cache.update(state=state, updated_at=asyncio.get_running_loop().time())
        return state


def _start_core_state_refresh() -> asyncio.Task[dict[str, Any]]:
    global _health_refresh_task
    if _health_refresh_task is None or _health_refresh_task.done():
        _health_refresh_task = asyncio.create_task(_cached_core_state())
    return _health_refresh_task


def _cors_allow_origins() -> list[str]:
    raw_origins = os.getenv("LILY_CORS_ALLOW_ORIGINS", "").strip()
    environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
    development = environment in {"development", "dev", "local"}
    if not raw_origins:
        return ["*"] if development else []
    if raw_origins == "*":
        return ["*"] if development else []
    return [origin.strip().rstrip("/") for origin in raw_origins.split(",") if origin.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)
app.add_middleware(RequestBodyLimitMiddleware)

_security_rate_limiter = SlidingWindowRateLimiter()
_security_audit = default_security_audit_log(CORE_DIR)


from lily_core.device_sessions import device_sessions
from lily_core.device_registry import DeviceRegistryError
from lily_core.family_sharing import FamilyServiceError, family_store, router as family_sharing_router


async def _family_retention_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(family_store.prune_expired)
        except Exception:
            logger.exception("Family retention cleanup failed.")
        await asyncio.sleep(60 * 60)


def _provided_owner_token(request: Request) -> str:
    authorization = request.headers.get("authorization", "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization.split(" ", 1)[1].strip()
    return request.headers.get("x-lily-owner-token", "").strip()


def _is_public_owner_api_request(method: str, path: str) -> bool:
    import re
    if method.upper() == "OPTIONS":
        return True

    if method.upper() == "POST" and path in {"/api/security/sessions/challenge", "/api/security/sessions/exchange"}:
        return True

    public_paths = {
        "/health/live",
        "/health/ready",
        "/api/system/capabilities",
        "/docs",
        "/openapi.json",
        "/redoc",
        "/api/power/events",
    }
    vessel_public = (method.upper() == 'POST' and path == '/api/security/vessels/requests') or bool(re.fullmatch(
        r'/api/security/vessels/requests/[a-f0-9]{32}/' + ('status' if method.upper() == 'GET' else 'activate' if method.upper() == 'POST' else 'never'), path))
    family_public = (
        method.upper() == "POST"
        and path in {
            "/api/family/pairing/requests",
            "/api/family/sessions/challenge",
            "/api/family/sessions/exchange",
        }
    ) or (
        method.upper() == "GET"
        and bool(re.fullmatch(r"/api/family/pairing/requests/[a-f0-9]{32}/status", path))
    )
    return family_public or vessel_public or path in public_paths or path.startswith("/static/") or (
        method.upper() == "POST" and path == "/api/security/pairing/requests"
    ) or (
        method.upper() == "GET" and path.startswith("/api/security/pairing/requests/")
        and path.endswith("/status")
        and len(path.split("/")) == 7
        and len(path.split("/")[5]) == 32
        and all(char in "0123456789abcdef" for char in path.split("/")[5])
    )


@app.middleware("http")
async def owner_api_auth(request: Request, call_next):
    path = request.url.path
    request_id = new_request_id()
    started_at = time.monotonic()
    client_host = request.client.host if request.client else "unknown"
    provided = _provided_owner_token(request)
    actor = actor_fingerprint(provided)
    rate = rate_limit_for_request(request.method, path)
    if rate:
        allowed, retry_after = await _security_rate_limiter.check(
            f"{client_host}:{request.method.upper()}:{rate_limit_bucket_path(path)}",
            rate[0],
            rate[1],
        )
        if not allowed:
            _security_audit.write(
                event="rate_limited",
                request_id=request_id,
                method=request.method,
                path=path,
                status=429,
                client=client_host,
                actor=actor,
            )
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": str(retry_after), "X-Request-ID": request_id},
                content={"detail": "Too many requests."},
            )
    if path.startswith("/static/audio/"):
        audio_access = verify_core_audio_url(
            path.removeprefix("/static/audio/"),
            request.query_params.get("expires"),
            request.query_params.get("signature"),
        )
        if audio_access == "expired":
            return JSONResponse(status_code=410, headers={"X-Request-ID": request_id}, content={"detail": "Audio URL has expired."})
        if audio_access != "ok":
            return JSONResponse(status_code=401, headers={"X-Request-ID": request_id}, content={"detail": "Invalid audio URL."})
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response
    is_public = _is_public_owner_api_request(request.method, path)
    device_authenticated = False
    if path.startswith("/api/family/") and not is_public:
        authorization = request.headers.get("authorization", "").strip()
        family_token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
        if not family_token.startswith("fam_"):
            return JSONResponse(status_code=401, content={"detail": "Family device session is required."})
        try:
            request.state.family_principal = await asyncio.to_thread(
                family_store.authenticate, family_token, request.method.upper(), path
            )
        except FamilyServiceError as error:
            return JSONResponse(status_code=error.status_code, content={"detail": str(error)})
        device_authenticated = True
    if provided.startswith("lds_") and not is_public:
        try:
            request.state.device_principal = await asyncio.to_thread(device_sessions.authorize, provided, request.method, path)
            request.state.device_session_token = provided
            device_authenticated = True
        except DeviceRegistryError as error:
            return JSONResponse(status_code=error.status_code, content={"detail": str(error)})
    if settings.owner_api_token_enforced and not is_public and not device_authenticated:
        if not settings.owner_api_token:
            return JSONResponse(status_code=503, headers={"X-Request-ID": request_id}, content={"detail": "Owner API authentication is misconfigured."})
        if not provided or not hmac.compare_digest(provided, settings.owner_api_token):
            _security_audit.write(
                event="authentication_failed",
                request_id=request_id,
                method=request.method,
                path=path,
                status=401,
                client=client_host,
                actor=actor,
            )
            return JSONResponse(status_code=401, headers={"X-Request-ID": request_id}, content={"detail": "Missing or invalid owner API token."})
    try:
        response = await call_next(request)
    except Exception:
        if request.method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
            _security_audit.write(
                event="mutation_completed",
                request_id=request_id,
                method=request.method,
                path=path,
                status=500,
                client=client_host,
                actor=actor,
                duration_ms=int((time.monotonic() - started_at) * 1000),
            )
        raise
    response.headers["X-Request-ID"] = request_id
    if path.startswith("/api/security/") or path.startswith("/api/family/") or path.startswith("/api/owner/family/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
    if request.method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
        _security_audit.write(
            event="mutation_completed",
            request_id=request_id,
            method=request.method,
            path=path,
            status=response.status_code,
            client=client_host,
            actor=actor,
            duration_ms=int((time.monotonic() - started_at) * 1000),
        )
    return response

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

from lily_core.wa_summary import router as wa_summary_router
app.include_router(wa_summary_router)
from lily_core.wa_secretary import router as wa_secretary_router
app.include_router(wa_secretary_router)
from lily_core.secretary_settings import router as secretary_settings_router
app.include_router(secretary_settings_router)
from lily_core.prompt_routes import router as prompt_router
app.include_router(prompt_router)
from lily_core.device_routes import router as device_router
app.include_router(device_router)
from lily_core.device_registry_routes import router as device_registry_router
app.include_router(device_registry_router)
from lily_core.vessel_pairing_routes import router as vessel_pairing_router
app.include_router(vessel_pairing_router)
from lily_core.listener_routes import router as listener_router
app.include_router(listener_router)
app.include_router(family_sharing_router)
from lily_core.network_devices import router as network_devices_router
app.include_router(network_devices_router)

class ChatRequest(BaseModel):
    message: str
    user_id: str
    want_voice: bool = False
    context: dict[str, Any] = Field(default_factory=dict)


class RuntimeSettingsUpdateRequest(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


class HudEventRequest(BaseModel):
    event: str = Field(min_length=1, max_length=80)
    state: str = Field(min_length=1, max_length=24)
    text: str = Field(default="", max_length=4000)
    audio_url: str = Field(default="", max_length=2000)
    expression: str = Field(default="", max_length=80)
    source: str = Field(default="core", max_length=80)


class HudNotificationRequest(BaseModel):
    text: str = Field(default="", max_length=6000)
    sender: str = Field(default="WhatsApp", max_length=100)
    summary: str = Field(default="", max_length=6000)
    source: str = Field(default="wa_inbox", max_length=80)
    notification_kind: str = Field(default="wa_inbox", max_length=40)
    priority: str = Field(default="normal", max_length=20)
    want_voice: bool = False
    voice_language: str = Field(default="", max_length=16)
    voice_profile: str = Field(default="", max_length=80)
    voice_route: str = Field(default="", max_length=40)


def _hud_source_enabled(source: str) -> bool:
    normalized = str(source or "").strip().lower()
    return normalized != "listener" and normalized in settings.hud_event_sources


_hud_event_signal = asyncio.Event()


def _notify_hud_event() -> None:
    _hud_event_signal.set()


def _publish_hud_processing(request: IngestRequest) -> None:
    if not _hud_source_enabled(request.source):
        return
    core_state_store.publish(
        "hud.state",
        {
            "event": "PROCESSING",
            "state": "THINKING",
            "source": request.source,
            "session_id": request.session_id,
            "trace_id": request.trace_id,
        },
    )
    _notify_hud_event()


def _publish_hud_idle(request: IngestRequest, *, reason: str) -> None:
    if not _hud_source_enabled(request.source):
        return
    core_state_store.publish(
        "hud.state",
        {
            "event": "IDLE",
            "state": "IDLE",
            "source": request.source,
            "session_id": request.session_id,
            "trace_id": request.trace_id,
            "reason": reason,
        },
    )
    _notify_hud_event()


class WakeRequest(BaseModel):
    target: str = ""
    source: str = "dashboard"
    reason: str = "manual wake request"
    force_local: bool = False


class DevicePowerEventRequest(BaseModel):
    event_type: str = Field(default="device_power.transition", max_length=80)
    timestamp: str = Field(default="", max_length=80)
    watcher_id: str = Field(default="", max_length=80)
    target: str = Field(min_length=1, max_length=80)
    target_label: str = Field(default="", max_length=120)
    action: str = Field(default="", max_length=40)
    state: str = Field(default="", max_length=40)
    detail: str = Field(default="", max_length=500)
    ok: bool = False


class HomeSceneActivateRequest(BaseModel):
    dry_run: bool = False


class SttSegmentResponse(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    text: str = Field(max_length=2000)
    avg_logprob: float = 0.0
    no_speech_probability: float = Field(default=0.0, ge=0, le=1)


class SttTranscriptionResponse(BaseModel):
    text: str = Field(max_length=20_000)
    language: str = Field(default="", max_length=32)
    duration_seconds: float = Field(default=0.0, ge=0, le=3600)
    model: str = Field(default="", max_length=128)
    provider: str = Field(default="", max_length=32)
    confidence: float = Field(default=0.0, ge=0, le=1)
    no_speech_probability: float = Field(default=0.0, ge=0, le=1)
    language_probability: float = Field(default=0.0, ge=0, le=1)
    segments: list[SttSegmentResponse] = Field(default_factory=list, max_length=2000)


def _raise_finance_error(error: FinanceProxyError) -> None:
    raise HTTPException(status_code=error.status_code, detail=error.detail) from error


def _public_finance_summary(payload: dict[str, Any]) -> dict[str, Any]:
    accounts = public_account_payload(
        {
            "items": payload.get("accounts") or [],
            "total_balance": payload.get("total_balance") or 0,
            "currency": payload.get("currency") or "IDR",
        }
    )
    return {
        "month": payload.get("month"),
        "income": int(payload.get("income") or 0),
        "expense": int(payload.get("expense") or 0),
        "transfer_in": int(payload.get("transfer_in") or 0),
        "transfer_out": int(payload.get("transfer_out") or 0),
        "net": int(payload.get("net") or 0),
        "total_balance": accounts["total_balance"],
        "accounts": accounts["items"],
        "currency": accounts["currency"],
    }


class OwnerPresenceRequest(BaseModel):
    status: str = "available"
    label: str | None = None
    note: str | None = None
    source: str = "dashboard"
    ttl_minutes: int | None = None
    expires_at: str | None = None


class OwnerActivityRequest(BaseModel):
    activity: str = "app_foreground"
    source: str = "mobile_realm"
    device_id: str | None = None
    confidence: str = "medium"


class OwnerRoutineToggleRequest(BaseModel):
    enabled: bool = True


class OwnerRoutineClaimRequest(BaseModel):
    profile: str = "public"


class OwnerRoutineAckRequest(BaseModel):
    delivery_id: str = Field(min_length=1, max_length=120)
    lease_token: str = Field(min_length=1, max_length=120)
    success: bool
    profile: str = "public"
    error: str = Field(default="", max_length=500)


class WaRuntimeReportRequest(BaseModel):
    profile: str
    ready: bool = False
    client_state: str = "unknown"
    state_updated_at: str | None = None
    routine_delivery: dict[str, Any] | None = None


class OwnerMoodProactiveRequest(BaseModel):
    profile: str = "public"
    min_idle_seconds: int = Field(default=4 * 3600, ge=60, le=7 * 86400)
    cooldown_seconds: int = Field(default=6 * 3600, ge=60, le=7 * 86400)
    max_per_day: int = Field(default=3, ge=1, le=12)
    quiet_hours_active: bool = False


class OwnerMemoryPinRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class OwnerMemoryUnpinRequest(BaseModel):
    index: int = Field(ge=1, le=24)


class StreamStageVisionRequest(BaseModel):
    image_base64: str
    session_id: str = "live-main"
    context_note: str = "general scene check"
    scene_name: str = "stream_stage"
    event_type: str = "frame_capture"
    want_voice: bool = True
    voice_route: str | None = None
    address_term: str | None = None
    live2d_model_id: str | None = None
    live2d_expression_options: list[str] = Field(default_factory=list)


class StreamStageChatEventRequest(BaseModel):
    message: str
    sender_name: str = "Stage Tester"
    platform: str = "manual"
    session_id: str = "live-main"
    event_type: str = "viewer_chat"
    want_reply: bool = False
    voice_route: str | None = None
    address_term: str | None = None
    is_owner_chat: bool = False
    live2d_model_id: str | None = None
    live2d_expression_options: list[str] = Field(default_factory=list)


class StreamStageLiveSettingsRequest(BaseModel):
    game_title: str = Field(default="", max_length=120)
    stream_topic: str = Field(default="", max_length=500)
    streamer_about: str = Field(default="", max_length=500)
    lily_guidance: str = Field(default="", max_length=500)
    reply_enabled: bool = False
    reply_cooldown_seconds: int = Field(default=30, ge=5, le=600)
    per_user_cooldown_seconds: int = Field(default=120, ge=5, le=3600)
    max_replies_per_minute: int = Field(default=2, ge=1, le=12)
    chat_min_interval_ms: int = Field(default=1000, ge=0, le=10000)


class SessionStateUpdateRequest(BaseModel):
    mic_listening: bool | None = None
    mouse_tracking: bool | None = None
    paused: bool | None = None
    mode: str | None = None
    tiktok_connected: bool | None = None
    tiktok_unique_id: str | None = None
    tiktok_last_heartbeat_at: float | None = None
    tiktok_last_event_at: float | None = None
    tiktok_last_event_type: str | None = None
    tiktok_last_sender: str | None = None
    tiktok_event_count: int | None = None
    tiktok_status_detail: str | None = None


class OpenClawTaskRequest(BaseModel):
    task: str
    action: str | None = None
    source: str = "dashboard"
    requester: str = "dashboard"
    session_id: str = "dashboard-tools"
    require_approval: bool = False
    delivery_channel: str | None = None
    delivery_target: str | None = None
    delivery_profile: str = "personal"
    input_files: list[dict[str, Any]] = Field(default_factory=list)


class OpenClawApprovalRequest(BaseModel):
    approver: str = "owner"
    reason: str = ""
    idempotency_key: str = ""


class OpenClawRetryRequest(BaseModel):
    kind: str = "execution"
    idempotency_key: str = ""


class OpenClawMaintenancePruneRequest(BaseModel):
    dry_run: bool = False


class OpenClawDeliveredRequest(BaseModel):
    channel: str = "control_center"
    target: str = ""
    delivery_profile: str = "personal"
    consumer: str = ""


class OpenClawDeliveryReleaseRequest(BaseModel):
    channel: str = "control_center"
    target: str = ""
    delivery_profile: str = "personal"
    consumer: str = ""


async def save_chat_to_db(user_id: str, user_message: str, bot_response: str, romanji: str, speaker: str, db):
    """Optionally mirror chat history to legacy MongoDB."""
    if not MONGO_MIRROR_ENABLED:
        return
    chat_entry = {
        "user_id": user_id,
        "user_message": user_message,
        "bot_response": bot_response,
        "romanji": romanji,
        "speaker": speaker,
        "timestamp": datetime.utcnow()
    }
    await db.chats.insert_one(chat_entry)


def _normalize_history_timestamp(value):
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _core_events_to_history_rows(events):
    rows = []

    for event in reversed(events):
        metadata = event.get("metadata", {}) or {}
        user_message = str(metadata.get("user_message") or "").strip()
        bot_response = str(event.get("text") or "").strip()

        if not bot_response:
            continue

        rows.append(
            {
                "user_message": user_message or "[system event]",
                "bot_response": bot_response,
                "language_practice": metadata.get("language_practice"),
                "timestamp": datetime.utcfromtimestamp(
                    float(event.get("created_at") or datetime.utcnow().timestamp())
                ).isoformat(),
            }
        )

    return rows


async def _load_combined_history(user_id: str, limit: int, skip: int, db):
    fetch_count = min(5000, max(1, limit + skip))
    chats = []
    if MONGO_MIRROR_ENABLED:
        try:
            chats = await db.chats.find({"user_id": user_id}).sort("timestamp", -1).limit(fetch_count).to_list(length=fetch_count)
        except Exception as error:
            logger.warning("Legacy Mongo history mirror is unavailable: %s", error)

    mongo_rows = [
        {
            "user_message": chat["user_message"],
            "bot_response": chat["bot_response"],
            "timestamp": _normalize_history_timestamp(chat.get("timestamp")),
        }
        for chat in reversed(chats)
    ]

    persisted_events = await asyncio.to_thread(core_state_store.load_session_events, user_id, fetch_count)
    core_rows = _core_events_to_history_rows(persisted_events)

    merged = {}
    for item in mongo_rows + core_rows:
        key = (
            str(item.get("user_message", "")),
            str(item.get("bot_response", "")),
            str(item.get("timestamp", "")),
        )
        merged[key] = item

    ordered = sorted(
        merged.values(),
        key=lambda item: str(item.get("timestamp", "")),
    )

    if skip:
        ordered = ordered[:-skip] if len(ordered) > skip else []
    if limit > 0:
        ordered = ordered[-limit:]

    return ordered


def _build_dashboard_ingest_request(chat_request: ChatRequest, want_voice: bool = True) -> IngestRequest:
    session_id = (chat_request.user_id or "").strip() or "owner-main"
    context = chat_request.context if isinstance(chat_request.context, dict) else {}
    return IngestRequest(
        source="dashboard",
        session_id=session_id,
        mode="owner_chat",
        payload={
            "message": chat_request.message,
            "context": context,
            "want_voice": want_voice,
            "want_subtitle": True,
        },
    )


async def _process_dashboard_chat(chat_request: ChatRequest):
    ingest_request = _build_dashboard_ingest_request(chat_request, want_voice=chat_request.want_voice)
    _publish_hud_processing(ingest_request)
    await asyncio.sleep(0.05)
    try:
        core_response = await core_service.ingest(ingest_request)
        _notify_hud_event()
        await asyncio.sleep(0)
    except Exception:
        _publish_hud_idle(ingest_request, reason="request_failed")
        raise
    result = core_response.get("result", {}) or {}

    metadata = result.get("metadata") if isinstance(result.get("metadata"), dict) else {}
    response_text = str(result.get("text") or "")
    response_romanji = str(metadata.get("voice_romanji") or "")
    speaker_name = "Lily"
    audio_path = result.get("audio_url")
    emotion = result.get("emotion")
    expression = result.get("expression")
    expression_source = metadata.get("expression_source")

    return response_text, response_romanji, speaker_name, audio_path, emotion, expression, expression_source, metadata, core_response

@app.post("/api/chat")
async def chat(chat_request: ChatRequest, db=Depends(get_database)):
    response_text, response_romanji, speaker_name, audio_path, emotion, expression, expression_source, metadata, core_response = await _process_dashboard_chat(chat_request)
    
    # Save chat history (Non-blocking / Optional)
    try:
        await save_chat_to_db(chat_request.user_id, chat_request.message, response_text, response_romanji, speaker_name, db)
    except Exception as e:
        logger.warning(f"Failed to save chat to DB (MongoDB might be down): {e}")
    
    return {
        "text": response_text,
        "romanji": response_romanji,
        "speaker": speaker_name,
        "audio": audio_path,
        "emotion": emotion,
        "expression": expression,
        "expression_source": expression_source,
        "voice_queue": metadata.get("voice_queue"),
        "voice_text": metadata.get("voice_text"),
        "voice_language": metadata.get("voice_output_language") or metadata.get("voice_language"),
        "owner_presence": metadata.get("owner_presence"),
        "owner_mood": metadata.get("owner_mood"),
        "mood_expression": metadata.get("mood_expression"),
        "mood_important": metadata.get("mood_important"),
        "trace_id": core_response.get("trace_id"),
        "priority": core_response.get("priority"),
    }

@app.post("/api/chat/stream")
async def chat_stream(chat_request: ChatRequest, db=Depends(get_database)):
    """
    Streaming endpoint: returns text response immediately,
    then streams audio via a separate SSE-like response.
    Use this when TTS_STREAM_MODE=stream.
    """
    response_text, response_romanji, speaker_name, audio_result, emotion, expression, expression_source, metadata, core_response = await _process_dashboard_chat(chat_request)

    # Save chat history
    try:
        await save_chat_to_db(chat_request.user_id, chat_request.message, response_text, response_romanji, speaker_name, db)
    except Exception as e:
        logger.warning(f"Failed to save chat to DB: {e}")

    # Modular core path currently returns normalized payloads and optional audio URLs.
    # Keep this endpoint backward compatible by returning the legacy JSON shape.
    return {
        "text": response_text,
        "romanji": response_romanji,
        "speaker": speaker_name,
        "audio": audio_result,
        "emotion": emotion,
        "expression": expression,
        "expression_source": expression_source,
        "voice_queue": metadata.get("voice_queue"),
        "voice_text": metadata.get("voice_text"),
        "voice_language": metadata.get("voice_output_language") or metadata.get("voice_language"),
        "owner_presence": metadata.get("owner_presence"),
        "owner_mood": metadata.get("owner_mood"),
        "mood_expression": metadata.get("mood_expression"),
        "mood_important": metadata.get("mood_important"),
        "trace_id": core_response.get("trace_id"),
        "priority": core_response.get("priority"),
    }

@app.get("/api/history")
async def get_chat_history(
    user_id: str = Query(..., description="User ID to fetch chat history"),
    limit: int = Query(10, ge=1, le=200, description="Number of records to fetch"),
    skip: int = Query(0, ge=0, le=5000, description="Number of newest records to skip"),
    db=Depends(get_database)
):
    """Retrieve chat history for a specific user with pagination."""
    return await _load_combined_history(user_id, limit, skip, db)

@app.get("/health/live")
async def health_live():
    """Fast process liveness endpoint without dependency probes."""
    return {
        "status": "ok",
        "service": "lily_web_backend",
        "component": "core",
        "timestamp": datetime.utcnow(),
    }


@app.get("/health/ready")
async def health_ready():
    """Bounded readiness endpoint that never blocks request routing."""
    try:
        cached = _health_cache.get("state")
        refresh_task = _start_core_state_refresh()
        if isinstance(cached, dict):
            core_state = cached
        else:
            core_state = await asyncio.wait_for(asyncio.shield(refresh_task), timeout=1.5)
        components = core_state.get("components", {})
        brain = components.get("brain") if isinstance(components, dict) else None
        brain_status = brain.get("status") if isinstance(brain, dict) else "unknown"
        ready = brain_status == "online"
        return {
            "status": "ready" if ready else "degraded",
            "service": "lily_web_backend",
            "core": "online",
            "brain": brain_status,
            "timestamp": datetime.utcnow(),
        }
    except Exception as error:
        return {
            "status": "degraded",
            "service": "lily_web_backend",
            "core": "online",
            "brain": "unknown",
            "detail": f"Readiness probe is still refreshing: {str(error)[:120]}",
            "timestamp": datetime.utcnow(),
        }


def _public_runtime_config(request: Request) -> tuple[str, dict[str, str]]:
    public_base_url = settings.public_base_url or str(request.base_url).rstrip("/")
    service_map: dict[str, str] = {}
    if settings.public_service_map:
        try:
            decoded = json.loads(settings.public_service_map)
            if isinstance(decoded, dict):
                service_map.update(
                    {
                        str(key): str(value).rstrip("/")
                        for key, value in decoded.items()
                        if str(value).startswith(("http://", "https://"))
                    }
                )
        except json.JSONDecodeError:
            logger.warning("LILY_PUBLIC_SERVICE_MAP is not valid JSON.")

    device_path = CORE_DIR.parent / ".lily-device.json"
    if device_path.is_file():
        try:
            device_config = json.loads(device_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            device_config = {}
        if isinstance(device_config, dict):
            configured_base = str(device_config.get("public_base_url") or "").strip().rstrip("/")
            if configured_base and not settings.public_base_url:
                public_base_url = configured_base
            configured_services = device_config.get("services")
            if isinstance(configured_services, dict):
                for key, value in configured_services.items():
                    normalized = str(value or "").strip().rstrip("/")
                    if normalized.startswith(("http://", "https://")):
                        service_map.setdefault(str(key), normalized)
    return public_base_url, service_map


@app.get("/api/system/runtime")
async def system_runtime():
    reader = _runtime_runpy.run_path(str(_RuntimePath(__file__).resolve().parents[1] / "scripts" / "runtime_status.py"))["status"]
    return await asyncio.to_thread(reader)


@app.get("/api/system/capabilities")
async def system_capabilities(request: Request) -> dict[str, Any]:
    public_base_url, service_map = _public_runtime_config(request)
    websocket_base_url = public_base_url.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    return {
        "schema_version": 2,
        "core": {
            "base_url": public_base_url,
            "events_url": f"{public_base_url}/api/events/stream",
            "hud_websocket_url": f"{websocket_base_url}/ws/hud",
        },
        "features": {
            "home": settings.is_component_enabled("home") and bool(settings.home_vessel_url),
            "voice": True,
            "stt": settings.is_component_enabled("stt") and bool(settings.stt_service_url),
            "finance": settings.is_component_enabled("finance") and bool(settings.finance_vessel_url),
            "tools": settings.is_component_enabled("openclaw") and bool(settings.openclaw_enabled),
            "optional_vessels": True,
            "sse": True,
            "hud_websocket": True,
            "owner_auth_configured": bool(settings.owner_api_token),
            "owner_auth_enforced": bool(settings.owner_api_token_enforced),
        },
        "services": service_map,
        **public_capabilities(),
    }


@app.get("/api/settings")
async def get_runtime_settings() -> dict[str, Any]:
    """Return the owner settings catalog without returning any secret values."""
    cached_state = _health_cache.get("state")
    health = cached_state.get("components", {}) if isinstance(cached_state, dict) else {}
    return settings_snapshot(settings, health)


@app.patch("/api/settings")
async def patch_runtime_settings(request: RuntimeSettingsUpdateRequest) -> dict[str, Any]:
    """Persist and apply owner-managed URLs, provider values, and optional modules."""
    try:
        changed = await asyncio.to_thread(update_runtime_settings, settings, request.values)
        if changed:
            reset_provider_clients()
            _health_cache.update(state=None, updated_at=0.0)
        cached_state = _health_cache.get("state")
        health = cached_state.get("components", {}) if isinstance(cached_state, dict) else {}
        return {
            **settings_snapshot(settings, health),
            "changed": changed,
            "applied": True,
            "restart_required": False,
        }
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def _format_sse_event(event: dict[str, Any]) -> str:
    event_id = int(event.get("id") or 0)
    event_type = str(event.get("type") or "message").replace("\n", "")[:80]
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"id: {event_id}\nevent: {event_type}\ndata: {data}\n\n"


async def _iter_sse_events(
    cursor: int,
    *,
    heartbeat_seconds: float = 15.0,
    poll_interval: float = 0.75,
    device_token: str = "",
):
    last_heartbeat = time.monotonic()
    while True:
        if device_token:
            try:
                await asyncio.to_thread(device_sessions.authorize, device_token, "GET", "/api/events/stream")
            except DeviceRegistryError:
                return
        events = await asyncio.to_thread(core_state_store.replay, cursor, 100)
        if events:
            for event in events:
                cursor = int(event["id"])
                yield _format_sse_event(event)
            last_heartbeat = time.monotonic()
            continue

        if time.monotonic() - last_heartbeat >= heartbeat_seconds:
            heartbeat = json.dumps({"timestamp": time.time()}, separators=(",", ":"))
            yield f"event: heartbeat\ndata: {heartbeat}\n\n"
            last_heartbeat = time.monotonic()
        await asyncio.sleep(poll_interval)


@app.get("/api/events/stream")
async def events_stream(
    request: Request,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    after: int = Query(default=0, ge=0),
):
    try:
        cursor = max(after, int(last_event_id or 0))
    except ValueError:
        cursor = after

    return StreamingResponse(
        _iter_sse_events(cursor, device_token=getattr(request.state, "device_session_token", "")),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/health")
async def health_check():
    """Detailed backend health endpoint for dashboard and stream clients."""
    core_state = await _cached_core_state()
    components = core_state.get("components", {})
    component_statuses = [
        component.get("status")
        for component in components.values()
        if isinstance(component, dict) and component.get("status")
    ]

    overall_status = "ok"
    if any(status == "offline" for status in component_statuses):
        overall_status = "degraded"

    return {
        "status": overall_status,
        "service": "lily_web_backend",
        "timestamp": datetime.utcnow(),
        "components": components,
        "providers": core_state.get("providers", {}),
        "sessions": core_state.get("sessions", {}),
        "owner_presence": core_state.get("owner_presence"),
        "owner_mood": core_state.get("owner_mood"),
        "owner_routines": core_state.get("owner_routines"),
        "owner_runtime": core_state.get("owner_runtime"),
    }


@app.get("/api/owner/presence")
async def get_owner_presence():
    """Read the current manual owner presence hint."""
    return {
        "ok": True,
        "owner_presence": core_service.get_owner_presence(),
    }


@app.post("/api/owner/presence")
async def set_owner_presence(request: OwnerPresenceRequest):
    """Set the current manual owner presence hint."""
    payload = (
        request.model_dump(exclude_none=True)
        if hasattr(request, "model_dump")
        else request.dict(exclude_none=True)
    )
    result = core_service.set_owner_presence(payload)
    core_state_store.publish("presence.updated", {"status": result["owner_presence"].get("status")})
    return result


@app.post("/api/owner/activity")
async def observe_owner_activity(request: OwnerActivityRequest):
    """Record one owner activity event without starting a background heartbeat."""
    payload = (
        request.model_dump(exclude_none=True)
        if hasattr(request, "model_dump")
        else request.dict(exclude_none=True)
    )
    result = core_service.observe_owner_activity(payload)
    core_state_store.publish(
        "presence.updated",
        {
            "status": result["owner_presence"].get("status"),
            "automatic": True,
            "activity": result["owner_activity"].get("activity"),
        },
    )
    return result


async def _authenticate_hud_socket(websocket: WebSocket) -> int | None:
    await websocket.accept()
    try:
        hello = await asyncio.wait_for(websocket.receive_json(), timeout=5.0)
    except (asyncio.TimeoutError, ValueError, TypeError, WebSocketDisconnect):
        await websocket.close(code=4401, reason="HUD authentication timed out.")
        return None

    if not isinstance(hello, dict) or str(hello.get("type") or "").upper() != "HELLO":
        await websocket.close(code=4401, reason="HUD HELLO frame required.")
        return None

    provided = str(hello.get("token") or "")
    if provided.startswith("lds_"):
        try:
            await asyncio.to_thread(device_sessions.authorize, provided, "WS", "/ws/hud")
            websocket.state.device_session_token = provided
        except DeviceRegistryError:
            await websocket.close(code=4401, reason="Device session is invalid or denied.")
            return None
    elif settings.owner_api_token_enforced:
        provided = str(hello.get("token") or "")
        if not settings.owner_api_token or not hmac.compare_digest(provided, settings.owner_api_token):
            await websocket.close(code=4401, reason="Missing or invalid owner token.")
            return None

    try:
        return max(0, int(hello.get("after") or 0))
    except (TypeError, ValueError):
        return 0


def _runtime_event_to_hud_payload(runtime_event: dict[str, Any]) -> dict[str, Any] | None:
    event_type = str(runtime_event.get("type") or "").strip().lower()
    payload = runtime_event.get("payload") if isinstance(runtime_event.get("payload"), dict) else {}
    if event_type == "hud.live_chat":
        if str(payload.get("source") or "").strip().lower() != "tiktok_bridge":
            return None
        sender = " ".join(str(payload.get("sender") or "TikTok viewer").split())[:48]
        message = " ".join(str(payload.get("message") or "").split())[:280]
        if not message:
            return None
        return {
            "event": "LIVE_CHAT",
            "state": "IDLE",
            "sender": sender or "TikTok viewer",
            "message": message,
            "platform": "TikTok",
        }
    if event_type == "hud.state":
        return payload

    text = ""
    source = event_type
    if event_type == "tool.updated":
        status = str(payload.get("status") or "").strip().lower()
        if status not in {"complete", "completed", "failed", "denied", "delivered"}:
            return None
        text = "Agent task completed." if status in {"complete", "completed", "delivered"} else f"Agent task {status}."
    elif event_type == "device_power.transition":
        label = str(payload.get("target_label") or payload.get("target") or "Device").strip()
        state = str(payload.get("state") or "updated").strip().replace("_", " ")
        text = f"{label} is {state}."
    elif event_type in {"resident_identified", "home.security.iris.resident_identified"}:
        name = str(payload.get("resident") or payload.get("name") or "a resident").strip()
        text = f"Iris recognized {name}."
    elif event_type in {"unknown_person", "home.security.iris.unknown_person"}:
        text = "Iris detected an unknown person."
    elif event_type == "runtime.wa.updated" and payload.get("ready") is False:
        profile = str(payload.get("profile") or "WhatsApp").strip()
        text = f"{profile.title()} WhatsApp bridge went offline."
    else:
        return None

    explicit_text = str(payload.get("message") or payload.get("text") or payload.get("detail") or "").strip()
    return {
        "event": "NOTIFICATION",
        "state": "IDLE",
        "label": "Notice",
        "text": (explicit_text or text)[:500],
        "source": source,
    }


async def _probe_hud_service(url: str, token: str = "", timeout_seconds: float = 1.0) -> dict[str, Any]:
    if not url:
        return {"status": "unconfigured", "latency_ms": None}
    path = urlsplit(url).path.rstrip("/").lower()
    health_url = url if path.endswith(("/health", "/health/live")) else f"{url.split('/api/', 1)[0].rstrip('/')}/health"
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    timeout = max(0.2, min(float(timeout_seconds), 15.0))
    started_at = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await asyncio.wait_for(client.get(health_url, headers=headers), timeout=timeout)
        latency_ms = round((time.perf_counter() - started_at) * 1000)
        if response.status_code >= 400:
            return {"status": "offline", "latency_ms": latency_ms}
        body = response.json() if response.content else {}
        status = str(body.get("status") or "online").lower() if isinstance(body, dict) else "online"
        return {"status": "online" if status in {"ok", "ready", "online"} else status, "latency_ms": latency_ms}
    except (asyncio.TimeoutError, httpx.RequestError, ValueError):
        return {"status": "offline", "latency_ms": None}


@app.get("/api/hud/diagnostics")
async def hud_diagnostics():
    cached_state = _health_cache.get("state")
    components = cached_state.get("components", {}) if isinstance(cached_state, dict) else {}
    stt_probe, voice_probe = await asyncio.gather(
        _probe_hud_service(settings.stt_service_url, settings.stt_service_token),
        _probe_hud_service(
            settings.voice_service_health_url or settings.voice_service_url,
            settings.voice_service_token,
            settings.voice_service_health_timeout_seconds,
        ),
    )
    return {
        "ok": True,
        "core": "online",
        "components": {
            "brain": components.get("brain", {"status": "checking"}),
            "stt": stt_probe,
            "voice": {**components.get("voice", {}), **voice_probe},
        },
    }


@app.websocket("/ws/hud")
async def hud_websocket(websocket: WebSocket):
    cursor = await _authenticate_hud_socket(websocket)
    if cursor is None:
        return
    # A desktop notice is live UI, not a replay of days of runtime history.
    cursor = await asyncio.to_thread(core_state_store.recent_event_cursor, cursor, 60.0)

    await websocket.send_json(
        {
            "event": "HUD_READY",
            "state": "IDLE",
            "cursor": cursor,
            "timestamp": time.time(),
        }
    )
    last_heartbeat = time.monotonic()

    try:
        while True:
            device_token = getattr(websocket.state, "device_session_token", "")
            if device_token:
                try:
                    await asyncio.to_thread(device_sessions.authorize, device_token, "WS", "/ws/hud")
                except DeviceRegistryError:
                    await websocket.close(code=4401, reason="Device session expired or revoked.")
                    return
            _hud_event_signal.clear()
            events = await asyncio.to_thread(core_state_store.replay, cursor, 100)
            for runtime_event in events:
                cursor = int(runtime_event["id"])
                payload = _runtime_event_to_hud_payload(runtime_event)
                if payload is None:
                    continue
                await websocket.send_json(
                    {
                        **payload,
                        "event": str(payload.get("event") or "IDLE").upper(),
                        "state": str(payload.get("state") or "IDLE").upper(),
                        "cursor": cursor,
                        "timestamp": runtime_event.get("created_at") or time.time(),
                    }
                )

            if time.monotonic() - last_heartbeat >= 15.0:
                await websocket.send_json({"event": "HEARTBEAT", "cursor": cursor, "timestamp": time.time()})
                last_heartbeat = time.monotonic()

            heartbeat_wait = max(0.1, 15.0 - (time.monotonic() - last_heartbeat))
            receive_task = asyncio.create_task(websocket.receive_json())
            signal_task = asyncio.create_task(_hud_event_signal.wait())
            socket_tasks = {receive_task, signal_task}
            done = set()
            try:
                done, _ = await asyncio.wait(
                    socket_tasks,
                    timeout=min(heartbeat_wait, 2.0),
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                for task in socket_tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*socket_tasks, return_exceptions=True)
            if receive_task not in done:
                continue
            incoming = receive_task.result()
            if isinstance(incoming, dict):
                incoming_type = str(incoming.get("type") or "").upper()
                if incoming_type == "PING":
                    await websocket.send_json({"event": "PONG", "cursor": cursor, "timestamp": time.time()})
                elif incoming_type == "HOTKEY_ACTIVATE":
                    await asyncio.to_thread(
                        core_state_store.publish,
                        "hud.state",
                        {
                            "event": "HOTKEY_ACTIVATED",
                            "state": "LISTENING",
                            "text": "I am listening.",
                            "source": "lily_hud_vessel",
                        },
                    )
                    _notify_hud_event()
    except (WebSocketDisconnect, asyncio.CancelledError):
        return


@app.post("/api/hud/event")
async def publish_hud_event(request: HudEventRequest):
    payload = request.model_dump()
    payload["event"] = request.event.strip().upper()
    payload["state"] = request.state.strip().upper()
    event_id = await asyncio.to_thread(core_state_store.publish, "hud.state", payload)
    _notify_hud_event()
    return {"ok": True, "event_id": event_id, "payload": payload}


@app.post("/api/hud/notify")
async def publish_hud_notification(request: HudNotificationRequest):
    """Publish one owner-only desktop notice, with optional Lily voice audio."""
    sender = " ".join(request.sender.split()).strip()[:100] or "WhatsApp"
    summary = (request.summary or request.text).strip()[:6000]
    display_text = f"{sender}: {summary}" if summary else f"New message from {sender}."
    audio_url = ""

    if request.want_voice:
        announcement = f"Pesan WhatsApp dari {sender}. {summary}" if summary else display_text
        try:
            if request.voice_language.strip().lower() in {"en", "ja"}:
                from lily_core.response_support import _prepare_voice_output

                announcement, _, translation_error = await _prepare_voice_output(
                    announcement,
                    {"language": "id", "voice_output_language": request.voice_language.strip().lower(),
                     "translate_voice_output": True},
                    {"session_id": "hud-notification", "mode": "owner_chat"},
                    enabled=True,
                )
                if translation_error:
                    raise ValueError("Notification voice translation is unavailable")
            audio_url = await generate_voice_result(
                announcement,
                emotion="neutral",
                style="jarvis_notification",
                language=request.voice_language.strip() or None,
                voice_profile=request.voice_profile.strip() or None,
                voice_route=request.voice_route.strip() or None,
            ) or ""
        except Exception as error:
            logger.warning("HUD notification voice generation failed: %s", error)

    priority = request.priority.strip().lower()
    payload = {
        "event": "NOTIFICATION",
        "state": "SPEAKING" if audio_url else "IDLE",
        "label": "WA INBOX",
        "text": display_text[:6100],
        "audio_url": audio_url,
        "source": request.source.strip() or "wa_inbox",
        "notification_kind": request.notification_kind.strip() or "wa_inbox",
        "expires_at": time.time() + 60,
        "sender": sender,
        "summary": summary,
        "priority": priority if priority in {"normal", "high", "urgent"} else "normal",
    }
    event_id = await asyncio.to_thread(core_state_store.publish, "hud.state", payload)
    _notify_hud_event()
    return {
        "ok": True,
        "event_id": event_id,
        "voice_available": bool(audio_url),
        "payload": payload,
    }


@app.get("/api/owner/mood")
async def get_owner_mood():
    """Read Lily's durable owner-only mood state."""
    return {
        "ok": True,
        "owner_mood": core_service.get_owner_mood(),
    }


@app.post("/api/owner/mood/proactive/claim")
async def claim_owner_mood_proactive(request: OwnerMoodProactiveRequest):
    """Atomically claim and generate one owner-only proactive WhatsApp message."""
    return await core_service.claim_proactive_owner_message(
        profile=request.profile.strip().lower(),
        min_idle_seconds=request.min_idle_seconds,
        cooldown_seconds=request.cooldown_seconds,
        max_per_day=request.max_per_day,
        quiet_hours_active=request.quiet_hours_active,
    )


@app.get("/api/owner/routines")
async def get_owner_routines():
    return core_service.get_owner_routines()


@app.put("/api/owner/routines")
async def set_owner_routines_enabled(request: OwnerRoutineToggleRequest):
    result = core_service.set_owner_routines_enabled(request.enabled)
    core_state_store.publish("routine.updated", {"enabled": result.get("enabled")})
    return result


@app.put("/api/owner/routines/{routine_id}")
async def set_owner_routine_enabled(routine_id: str, request: OwnerRoutineToggleRequest):
    try:
        result = core_service.set_owner_routine_enabled(routine_id, request.enabled)
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Unknown owner routine.") from error
    core_state_store.publish(
        "routine.updated",
        {"routine_id": routine_id, "enabled": request.enabled},
    )
    return result


@app.post("/api/owner/routines/claim")
async def claim_owner_routine(request: OwnerRoutineClaimRequest):
    return core_service.claim_owner_routine(request.profile.strip().lower())


@app.post("/api/owner/routines/ack")
async def acknowledge_owner_routine(request: OwnerRoutineAckRequest):
    try:
        return core_service.acknowledge_owner_routine(
            delivery_id=request.delivery_id,
            lease_token=request.lease_token,
            success=request.success,
            profile=request.profile.strip().lower(),
            error=request.error,
        )
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Unknown routine delivery.") from error


@app.post("/api/owner/runtime/wa")
async def report_wa_runtime(request: WaRuntimeReportRequest):
    payload = request.model_dump(exclude_none=True) if hasattr(request, "model_dump") else request.dict(exclude_none=True)
    try:
        result = core_service.report_wa_runtime(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if result.get("changed"):
        core_state_store.publish(
            "runtime.wa.updated",
            {
                "profile": result["profile"].get("profile"),
                "ready": result["profile"].get("ready"),
                "client_state": result["profile"].get("client_state"),
            },
        )
    return result


@app.get("/api/owner/runtime")
async def get_owner_runtime():
    return core_service.get_owner_runtime()


def _raise_home_http_error(error: HomeControlError) -> None:
    raise HTTPException(status_code=error.status_code, detail=error.detail) from error


def _sanitize_home_control_response(payload: dict[str, Any]) -> dict[str, Any]:
    response = {
        "ok": bool(payload.get("ok", False)),
        "device_id": str(payload.get("device_id") or ""),
        "provider": str(payload.get("provider") or ""),
        "dry_run": bool(payload.get("dry_run", False)),
        "detail": str(payload.get("detail") or ""),
        "requested": payload.get("requested") if isinstance(payload.get("requested"), dict) else {},
    }
    if isinstance(payload.get("state"), dict):
        response["state"] = sanitize_home_state(payload["state"])
    return response


@app.get("/api/home/devices")
async def home_devices():
    client = create_home_client()
    try:
        devices = await asyncio.to_thread(client.list_devices)
    except HomeControlError as error:
        _raise_home_http_error(error)
    return {"devices": [sanitize_home_device(device) for device in devices]}


@app.get("/api/home/devices/{device_id}/state")
async def home_device_state(device_id: str):
    client = create_home_client()
    try:
        state = await asyncio.to_thread(client.get_state, device_id)
    except HomeControlError as error:
        _raise_home_http_error(error)
    return sanitize_home_state(state)


@app.post("/api/home/devices/{device_id}/state")
async def set_home_device_state(device_id: str, request: HomeDeviceControlRequest):
    client = create_home_client()
    try:
        result = await asyncio.to_thread(
            client.set_state,
            device_id,
            request.model_dump(exclude_none=True),
        )
    except HomeControlError as error:
        _raise_home_http_error(error)
    response = _sanitize_home_control_response(result)
    core_state_store.publish("home.updated", {"device_id": device_id, "state": response.get("state")})
    return response


@app.get("/api/home/scenes")
async def home_scenes():
    client = create_home_client()
    try:
        scenes = await asyncio.to_thread(client.list_scenes)
    except HomeControlError as error:
        _raise_home_http_error(error)
    return {"scenes": [sanitize_home_scene(scene) for scene in scenes]}


@app.get("/api/home/scenes/{scene_id}")
async def home_scene(scene_id: str):
    client = create_home_client()
    try:
        scene = await asyncio.to_thread(client.get_scene, scene_id)
    except HomeControlError as error:
        _raise_home_http_error(error)
    return sanitize_home_scene(scene)


@app.put("/api/home/scenes/{scene_id}")
async def put_home_scene(scene_id: str, request: HomeSceneUpsertRequest):
    client = create_home_client()
    try:
        scene = await asyncio.to_thread(
            client.put_scene,
            scene_id,
            request.model_dump(mode="json"),
        )
    except HomeControlError as error:
        _raise_home_http_error(error)
    response = sanitize_home_scene(scene)
    core_state_store.publish("home.scene.updated", {"scene_id": scene_id})
    return response


@app.delete("/api/home/scenes/{scene_id}")
async def delete_home_scene(scene_id: str):
    client = create_home_client()
    try:
        result = await asyncio.to_thread(client.delete_scene, scene_id)
    except HomeControlError as error:
        _raise_home_http_error(error)
    response = {"ok": bool(result.get("ok")), "scene_id": str(result.get("scene_id") or scene_id)}
    core_state_store.publish("home.scene.deleted", {"scene_id": response["scene_id"]})
    return response


@app.post("/api/home/scenes/{scene_id}/activate")
async def activate_home_scene(scene_id: str, request: HomeSceneActivateRequest):
    client = create_home_client()
    try:
        result = await asyncio.to_thread(client.activate_scene, scene_id, request.dry_run)
    except HomeControlError as error:
        _raise_home_http_error(error)
    response = {
        "ok": bool(result.get("ok")),
        "scene_id": str(result.get("scene_id") or scene_id),
        "dry_run": bool(result.get("dry_run", request.dry_run)),
        "results": [
            _sanitize_home_control_response(item)
            for item in (result.get("results") or [])
            if isinstance(item, dict)
        ],
    }
    core_state_store.publish("home.updated", {"scene_id": scene_id, "dry_run": request.dry_run})
    return response


@app.get("/api/finance/accounts")
async def finance_accounts() -> dict[str, Any]:
    try:
        payload = await create_finance_client().request("GET", "/api/finance/accounts")
    except FinanceProxyError as error:
        _raise_finance_error(error)
    return public_account_payload(payload)


@app.get("/api/finance/summary")
async def finance_summary(month: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$")) -> dict[str, Any]:
    try:
        payload = await create_finance_client().request(
            "GET",
            "/api/finance/summary",
            params={"month": month} if month else None,
        )
    except FinanceProxyError as error:
        _raise_finance_error(error)
    return _public_finance_summary(payload)


@app.get("/api/finance/transactions")
async def finance_transactions(
    limit: int = Query(default=25, ge=1, le=100),
    account: str | None = Query(default=None, max_length=40),
) -> dict[str, Any]:
    params: dict[str, Any] = {"limit": limit}
    if account:
        params["account"] = account
    try:
        payload = await create_finance_client().request("GET", "/api/finance/transactions", params=params)
    except FinanceProxyError as error:
        _raise_finance_error(error)
    return public_transaction_payload(payload)


@app.post("/api/finance/interpret")
async def finance_interpret(request: FinanceInterpretRequest) -> dict[str, Any]:
    upstream_request = request.model_dump(exclude_none=True)
    upstream_request["source"] = "mobile"
    try:
        payload = await create_finance_client().request(
            "POST",
            "/api/finance/interpret",
            json=upstream_request,
        )
    except FinanceProxyError as error:
        _raise_finance_error(error)

    raw_transactions = payload.get("transactions") if isinstance(payload.get("transactions"), list) else []
    if isinstance(payload.get("transaction"), dict):
        raw_transactions = [payload["transaction"], *raw_transactions]
    drafts = []
    for raw_transaction in raw_transactions[:10]:
        try:
            transaction = transaction_from_upstream(raw_transaction)
        except ValueError:
            continue
        if transaction:
            drafts.append(finance_drafts.create(transaction, "mobile").model_dump())

    summary_payload = None
    if payload.get("intent") in {"balance_query", "period_followup"}:
        try:
            raw_summary = await create_finance_client().request(
                "GET",
                "/api/finance/summary",
                params={"month": payload.get("period")} if payload.get("period") else None,
            )
            summary_payload = _public_finance_summary(raw_summary)
        except FinanceProxyError:
            summary_payload = None

    for draft in drafts:
        core_state_store.publish("finance.draft.updated", {"draft_id": draft["id"], "status": "pending"})

    return {
        "intent": str(payload.get("intent") or "chat")[:40],
        "confidence": max(0.0, min(1.0, float(payload.get("confidence") or 0.0))),
        "needs_confirmation": bool(drafts),
        "reply": str(payload.get("reply") or "")[:2000],
        "account": str(payload.get("account") or "")[:80] or None,
        "period": str(payload.get("period") or "")[:40],
        "reason": str(payload.get("reason") or "")[:500],
        "drafts": drafts,
        "summary": summary_payload,
    }


@app.post("/api/finance/drafts")
async def finance_create_draft(request: FinanceDraftCreate) -> dict[str, Any]:
    draft = finance_drafts.create(request.transaction, "api").model_dump()
    core_state_store.publish("finance.draft.updated", {"draft_id": draft["id"], "status": "pending"})
    return draft


@app.get("/api/finance/drafts/{draft_id}")
async def finance_get_draft(draft_id: str) -> dict[str, Any]:
    draft = finance_drafts.get(draft_id)
    if not draft:
        raise HTTPException(status_code=404, detail="Finance draft was not found or expired.")
    return draft.model_dump()


@app.delete("/api/finance/drafts/{draft_id}")
async def finance_cancel_draft(draft_id: str) -> dict[str, bool]:
    if not finance_drafts.delete(draft_id):
        raise HTTPException(status_code=404, detail="Finance draft was not found or expired.")
    core_state_store.publish("finance.draft.updated", {"draft_id": draft_id, "status": "cancelled"})
    return {"ok": True}


@app.post("/api/finance/drafts/{draft_id}/confirm")
async def finance_confirm_draft(draft_id: str, _request: FinanceConfirmRequest) -> dict[str, Any]:
    draft = finance_drafts.begin_confirmation(draft_id)
    if not draft:
        raise HTTPException(status_code=404, detail="Finance draft was not found, expired, or is already confirming.")

    transaction_payload = draft.transaction.model_dump(exclude_none=True)
    transaction_payload["source"] = "mobile" if draft.source in {"mobile", "receipt"} else "api"
    transaction_payload["status"] = "confirmed"
    try:
        transaction = await create_finance_client().request(
            "POST",
            "/api/finance/transactions",
            json=transaction_payload,
        )
    except FinanceProxyError as error:
        finance_drafts.restore(draft_id)
        _raise_finance_error(error)
    finance_drafts.delete(draft_id)
    public_items = public_transaction_payload({"items": [transaction]})["items"]
    if not public_items:
        raise HTTPException(status_code=502, detail="Finance service returned an invalid transaction.")
    core_state_store.publish(
        "finance.updated",
        {"draft_id": draft_id, "transaction_id": public_items[0]["id"]},
    )
    return {"ok": True, "transaction": public_items[0]}


@app.post("/api/finance/receipts/parse")
async def finance_parse_receipt(
    file: UploadFile = File(...),
    account: str = Form(default="", max_length=40),
    hint: str = Form(default="", max_length=500),
) -> dict[str, Any]:
    content_type = (file.content_type or "").lower()
    if content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=415, detail="Receipt must be JPEG, PNG, or WebP.")
    image_bytes = await file.read(settings.finance_receipt_max_bytes + 1)
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Receipt image is empty.")
    if len(image_bytes) > settings.finance_receipt_max_bytes:
        raise HTTPException(status_code=413, detail="Receipt image is too large.")

    request_payload: dict[str, Any] = {
        "image_base64": encode_receipt(image_bytes),
        "mime_type": content_type,
        "source": "mobile",
        "hint": hint,
    }
    if account:
        request_payload["account"] = account
    try:
        payload = await create_finance_client().request(
            "POST",
            "/api/finance/parse/image",
            json=request_payload,
        )
    except FinanceProxyError as error:
        _raise_finance_error(error)

    raw_transactions = payload.get("transactions") if isinstance(payload.get("transactions"), list) else []
    if isinstance(payload.get("transaction"), dict):
        raw_transactions = [payload["transaction"], *raw_transactions]
    drafts = []
    for raw_transaction in raw_transactions[:10]:
        try:
            transaction = transaction_from_upstream(raw_transaction)
        except ValueError:
            continue
        if transaction:
            drafts.append(finance_drafts.create(transaction, "receipt").model_dump())
    attachment = payload.get("attachment") if isinstance(payload.get("attachment"), dict) else {}
    response = {
        "ok": bool(payload.get("ok")),
        "confidence": max(0.0, min(1.0, float(payload.get("confidence") or 0.0))),
        "needs_confirmation": bool(drafts),
        "reason": str(payload.get("reason") or "")[:500],
        "drafts": drafts,
        "attachment": {
            "id": str(attachment.get("id") or "")[:80],
            "filename": str(attachment.get("filename") or Path(file.filename or "receipt").name)[:128],
        } if attachment else None,
    }
    for draft in drafts:
        core_state_store.publish("finance.draft.updated", {"draft_id": draft["id"], "status": "pending"})
    return response


@app.post("/api/stt/transcribe", response_model=SttTranscriptionResponse)
async def stt_transcribe(
    file: UploadFile = File(...),
    language: str = Form(default="", max_length=16),
    local_only: bool = False,
) -> SttTranscriptionResponse:
    if not settings.stt_service_url:
        raise HTTPException(status_code=503, detail="Speech transcription is not configured.")

    content_type = (file.content_type or "application/octet-stream").lower()
    if not content_type.startswith("audio/") and content_type != "application/ogg":
        raise HTTPException(status_code=415, detail="Only audio uploads are accepted.")

    audio_bytes = await file.read(settings.stt_max_upload_bytes + 1)
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio upload is empty.")
    if len(audio_bytes) > settings.stt_max_upload_bytes:
        raise HTTPException(status_code=413, detail="Audio upload is too large.")

    safe_filename = Path(file.filename or "mobile_voice.audio").name[:128] or "mobile_voice.audio"
    headers: dict[str, str] = {}
    if settings.stt_service_token:
        headers["Authorization"] = f"Bearer {settings.stt_service_token}"

    try:
        async with httpx.AsyncClient(timeout=settings.stt_service_timeout_seconds) as http_client:
            upstream_url = settings.stt_service_url
            if local_only:
                if not upstream_url.rstrip("/").endswith("/api/stt/transcribe"):
                    raise HTTPException(status_code=503, detail="Local-only STT requires the Lily STT Vessel endpoint.")
                upstream_url = upstream_url.rstrip("/") + "/local"
            response = await http_client.post(
                upstream_url,
                headers=headers,
                data={"language": language.strip().lower()},
                files={"file": (safe_filename, audio_bytes, content_type)},
            )
    except httpx.TimeoutException as error:
        raise HTTPException(status_code=504, detail="Speech transcription timed out.") from error
    except httpx.RequestError as error:
        raise HTTPException(status_code=503, detail="Speech transcription is unavailable.") from error

    if response.status_code >= 400:
        detail = "Speech transcription failed."
        try:
            upstream_detail = response.json().get("detail")
            if isinstance(upstream_detail, str) and upstream_detail.strip():
                detail = upstream_detail.strip()[:500]
        except (ValueError, AttributeError):
            pass
        status_code = response.status_code if response.status_code in {400, 413, 415, 422} else 502
        raise HTTPException(status_code=status_code, detail=detail)

    try:
        return SttTranscriptionResponse.model_validate(response.json())
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=502, detail="Speech transcription returned an invalid response.") from error


@app.post("/api/stt/transcribe/local", response_model=SttTranscriptionResponse)
async def stt_transcribe_local(
    file: UploadFile = File(...),
    language: str = Form(default="", max_length=16),
) -> SttTranscriptionResponse:
    return await stt_transcribe(file, language, local_only=True)


@app.post("/api/core/ingest")
async def core_ingest(request: IngestRequest):
    """Session-aware modular ingest route for dashboard, stream stage, and bridges."""
    _publish_hud_processing(request)
    await asyncio.sleep(0.05)
    try:
        result = await core_service.ingest(request)
        _notify_hud_event()
        await asyncio.sleep(0)
        return result
    except Exception:
        _publish_hud_idle(request, reason="request_failed")
        raise


@app.post("/api/core/route-intent")
async def core_route_intent(request: IntentRouteRequest):
    """Classify owner messages into a strict action intent without executing anything."""
    result = await route_owner_intent(request)
    context = request.context if isinstance(request.context, dict) else {}
    if request.source == "wa_bridge" and context.get("is_owner") is True:
        core_service.wa_owner_state.record_route(
            {
                **result.model_dump(),
                "message": request.message,
                "wa_profile": context.get("wa_profile"),
            }
        )
    return result


@app.get("/api/tools/openclaw/status")
async def openclaw_status(limit: int = Query(8, ge=1, le=40)):
    """Inspect OpenClaw availability and recent tool requests."""
    status = get_openclaw_health()
    requests = await list_openclaw_requests(limit=limit)
    status["recent"] = requests.get("items", status.get("recent", []))
    return status


@app.get("/api/tools/openclaw/requests")
async def openclaw_requests(limit: int = Query(12, ge=1, le=80)):
    """List recent OpenClaw task requests."""
    return await list_openclaw_requests(limit=limit)


@app.get("/api/tools/openclaw/maintenance")
async def openclaw_maintenance():
    """Return owner-visible artifact retention and quota information."""
    return get_openclaw_maintenance()


@app.post("/api/tools/openclaw/maintenance/prune")
async def openclaw_maintenance_prune(request: OpenClawMaintenancePruneRequest):
    """Prune only safe, Core-owned artifact files according to retention/quota policy."""
    return await prune_openclaw_artifacts(dry_run=request.dry_run)


@app.get("/api/tools/openclaw/deliveries/{channel}")
async def openclaw_deliveries(
    channel: str,
    limit: int = Query(8, ge=1, le=40),
    delivery_profile: str = Query("personal"),
    consumer: str = Query(""),
):
    """List finished OpenClaw tasks waiting for a channel-specific delivery."""
    return await list_openclaw_deliveries(
        channel=channel,
        limit=limit,
        delivery_profile=delivery_profile,
        consumer=consumer,
    )


@app.post("/api/tools/openclaw/request")
async def openclaw_request(request: OpenClawTaskRequest):
    """Create an OpenClaw task from approved Lily surfaces only."""
    result = await create_openclaw_request(
        task=request.task,
        source=request.source,
        requester=request.requester,
        session_id=request.session_id,
        action=request.action,
        require_approval=request.require_approval,
        delivery_channel=request.delivery_channel,
        delivery_target=request.delivery_target,
        delivery_profile=request.delivery_profile,
        input_files=request.input_files,
    )
    task = result.get("task") if isinstance(result.get("task"), dict) else {}
    core_state_store.publish("tool.updated", {"task_id": task.get("id"), "status": result.get("status")})
    return result


@app.post("/api/tools/openclaw/{task_id}/approve")
async def openclaw_approve(task_id: str, request: OpenClawApprovalRequest):
    """Approve and run a pending OpenClaw task."""
    result = await approve_openclaw_request(
        task_id,
        approver=request.approver,
        idempotency_key=request.idempotency_key,
    )
    core_state_store.publish("tool.updated", {"task_id": task_id, "status": result.get("status")})
    return result


@app.post("/api/tools/openclaw/{task_id}/deny")
async def openclaw_deny(task_id: str, request: OpenClawApprovalRequest):
    """Deny a pending OpenClaw task."""
    result = await deny_openclaw_request(task_id, approver=request.approver, reason=request.reason)
    core_state_store.publish("tool.updated", {"task_id": task_id, "status": result.get("status")})
    return result


@app.post("/api/tools/openclaw/{task_id}/cancel")
async def openclaw_cancel(task_id: str, request: OpenClawApprovalRequest):
    """Cancel a queued or running tool task and terminate its local execution where possible."""
    result = await cancel_openclaw_request(task_id, reason=request.reason or "Cancelled by owner.")
    core_state_store.publish("tool.updated", {"task_id": task_id, "status": result.get("status")})
    return result


@app.post("/api/tools/openclaw/{task_id}/retry")
async def openclaw_retry(task_id: str, request: OpenClawRetryRequest):
    """Retry execution or delivery as two separate owner actions."""
    result = await retry_openclaw_request(
        task_id,
        kind=request.kind,
        idempotency_key=request.idempotency_key,
    )
    core_state_store.publish("tool.updated", {"task_id": task_id, "status": result.get("status"), "retry_kind": request.kind})
    return result


@app.post("/api/tools/openclaw/{task_id}/delivered")
async def openclaw_delivered(task_id: str, request: OpenClawDeliveredRequest):
    """Mark a finished OpenClaw task as delivered to its original surface."""
    result = await mark_openclaw_delivered(
        task_id,
        channel=request.channel,
        target=request.target,
        delivery_profile=request.delivery_profile,
        consumer=request.consumer,
    )
    core_state_store.publish("tool.updated", {"task_id": task_id, "status": "delivered"})
    return result


@app.post("/api/tools/openclaw/{task_id}/delivery-release")
async def openclaw_delivery_release(task_id: str, request: OpenClawDeliveryReleaseRequest):
    """Release a channel delivery lease after a send failure."""
    result = await release_openclaw_delivery(
        task_id,
        channel=request.channel,
        target=request.target,
        delivery_profile=request.delivery_profile,
        consumer=request.consumer,
    )
    core_state_store.publish("tool.updated", {"task_id": task_id, "status": result.get("status")})
    return result


@app.get("/api/tools/openclaw/{task_id}/artifacts/{artifact_id}")
async def openclaw_artifact(task_id: str, artifact_id: str):
    """Download a safe artifact generated by an owner-approved tool task."""
    result = await get_openclaw_artifact(task_id, artifact_id)
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=result.get("detail") or "Artifact was not found.")

    artifact = result["artifact"]
    return FileResponse(
        str(result["path"]),
        media_type=artifact.get("mime_type") or "application/octet-stream",
        filename=artifact.get("name") or "artifact",
    )


@app.post("/api/stream-stage/vision")
async def stream_stage_vision(request: StreamStageVisionRequest):
    """Convenience route for Lily Stream Stage so frontend does not need to build ingest payloads."""
    ingest_request = IngestRequest(
        source="stream_stage",
        session_id=(request.session_id or "").strip() or "live-main",
        mode="gaming_companion",
        payload={
            "image_base64": request.image_base64,
            "context_note": request.context_note,
            "scene_name": request.scene_name,
            "event_type": request.event_type,
            "want_voice": request.want_voice,
            "voice_route": request.voice_route,
            "address_term": request.address_term,
            "live2d_model_id": request.live2d_model_id,
            "live2d_expression_options": request.live2d_expression_options,
        },
    )
    return await core_service.ingest(ingest_request)


@app.get("/api/stream-stage/live-settings")
async def stream_stage_live_settings(session_id: str = Query("live-main", min_length=1, max_length=80)):
    """Read the saved owner briefing and TikTok reply pace for a live session."""
    return core_service.get_live_settings(session_id)


@app.put("/api/stream-stage/live-settings")
async def stream_stage_save_live_settings(
    request: StreamStageLiveSettingsRequest,
    session_id: str = Query("live-main", min_length=1, max_length=80),
):
    """Persist an operator-edited briefing without changing transient viewer context."""
    values = request.model_dump()
    for key in ("game_title", "stream_topic", "streamer_about", "lily_guidance"):
        values[key] = " ".join(values[key].split())
    return core_service.save_live_settings(session_id, values)


@app.post("/api/stream-stage/chat-event")
async def stream_stage_chat_event(request: StreamStageChatEventRequest):
    """Inject a viewer-style chat event into Lily Stream Stage for testing or bridge input."""
    message = (request.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required.")

    ingest_request = IngestRequest(
        source="tiktok_bridge",
        session_id=(request.session_id or "").strip() or "live-main",
        mode="gaming_companion",
        payload={
            "sender_name": (request.sender_name or "").strip() or "Stage Tester",
            "user_message": message,
            "event_type": (request.event_type or "").strip() or "viewer_chat",
            "want_reply": bool(request.want_reply),
            "voice_route": request.voice_route,
            "address_term": request.address_term,
            "platform": (request.platform or "").strip() or "manual",
            "is_owner_chat": bool(request.is_owner_chat),
            "live2d_model_id": request.live2d_model_id,
            "live2d_expression_options": request.live2d_expression_options,
        },
    )
    return await core_service.ingest(ingest_request)


@app.post("/api/stream-stage/respond-latest")
async def stream_stage_respond_latest(
    session_id: str = Query("live-main"),
    live2d_model_id: str = Query(""),
    live2d_expression_options: str = Query(""),
    voice_route: str = Query(""),
    address_term: str = Query(""),
):
    """Ask Lily to answer the newest non-owner viewer message in the stage queue."""
    events_payload = core_service.get_events((session_id or "").strip() or "live-main", limit=40)
    events = events_payload.get("events", [])
    target_event = None

    for event in events:
        metadata = event.get("metadata", {}) or {}
        user_message = str(metadata.get("user_message") or "").strip()
        if user_message and not bool(metadata.get("is_owner_chat", False)):
            target_event = event
            break

    if not target_event:
        raise HTTPException(status_code=404, detail="No viewer message is available to answer.")

    metadata = target_event.get("metadata", {}) or {}
    ingest_request = IngestRequest(
        source="tiktok_bridge",
        session_id=(session_id or "").strip() or "live-main",
        mode="gaming_companion",
        payload={
            "sender_name": str(metadata.get("sender_name") or "Viewer"),
            "user_message": str(metadata.get("user_message") or ""),
            "event_type": "viewer_reply",
            "want_reply": True,
            "voice_route": voice_route,
            "address_term": address_term.strip() or None,
            "platform": str(metadata.get("platform") or "manual"),
            "is_owner_chat": False,
            "live2d_model_id": live2d_model_id.strip() or None,
            "live2d_expression_options": [
                value.strip() for value in live2d_expression_options.split("|") if value.strip()
            ],
        },
        priority=65,
    )
    return await core_service.ingest(ingest_request)


@app.get("/api/core/state")
async def core_state():
    """Inspect current modular Lily Core state without touching the older /api/chat flow."""
    return core_service.get_state()


@app.get("/api/core/session/{session_id}")
async def core_session(session_id: str):
    """Read one session and its recent events."""
    return core_service.get_session(session_id)


@app.post("/api/core/session/{session_id}/state")
async def core_session_state_update(session_id: str, request: SessionStateUpdateRequest):
    """Update lightweight session state for stage/dashboard clients."""
    return core_service.update_session_state(session_id, request.model_dump(exclude_none=True))


@app.get("/api/core/session/{session_id}/events")
async def core_session_events(session_id: str, limit: int = Query(10, ge=1, le=100)):
    """Poll recent per-session events for Stream Stage or dashboard clients."""
    return core_service.get_events(session_id, limit)


@app.post("/api/core/session/{session_id}/reset")
async def core_session_conversation_reset(session_id: str):
    """Clear conversational events while preserving the session and durable owner memory."""
    return core_service.reset_session_conversation(session_id)


@app.post("/api/core/session/{session_id}/forget-last")
async def core_session_forget_last(session_id: str):
    """Remove only the newest conversational turn from a session."""
    return core_service.forget_latest_session_event(session_id)


@app.get("/api/owner/wa/state")
async def owner_wa_state():
    """Inspect durable owner WhatsApp context shared by both WA profiles."""
    return core_service.get_wa_owner_state()


@app.post("/api/owner/wa/memory/pin")
async def owner_wa_memory_pin(request: OwnerMemoryPinRequest):
    """Pin owner-approved context without exposing it to public chat sessions."""
    return core_service.pin_wa_owner_memory(request.text)


@app.post("/api/owner/wa/memory/unpin")
async def owner_wa_memory_unpin(request: OwnerMemoryUnpinRequest):
    """Remove one owner-pinned memory by its one-based index."""
    return core_service.unpin_wa_owner_memory(request.index)


@app.post("/api/power/wake")
async def wake_power(
    wake_request: WakeRequest,
    x_lily_token: str | None = Header(default=None)
):
    """Shared wake endpoint for dashboard, bridge, or other future clients."""
    shared_token = os.getenv("LILY_WAKE_API_TOKEN", "").strip() or None
    try:
        verify_optional_wake_token(shared_token, x_lily_token)
        if wake_request.target.strip():
            return execute_target_wake_power(
                target_id=wake_request.target.strip(),
                source=wake_request.source,
                reason=wake_request.reason,
            )
        return execute_wake_power(
            source=wake_request.source,
            reason=wake_request.reason,
            force_local=wake_request.force_local,
        )
    except WakePowerError as error:
        logger.warning(f"Wake request failed: {error.detail}")
        raise HTTPException(status_code=error.status_code, detail=error.detail)


@app.get("/api/power/targets")
async def power_targets():
    return {
        "targets": [
            {
                "id": item["id"],
                "label": item["label"],
                "enabled": item["enabled"],
                "wake_enabled": item.get("wake_enabled", False),
                "allowed_actions": item["allowed_actions"],
            }
            for item in list_device_power_targets()
        ]
    }


@app.get("/api/power/status")
async def power_status(target: str = Query(default="", max_length=80)):
    try:
        return await asyncio.to_thread(get_device_power_status, target)
    except DevicePowerError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error


@app.get("/api/power/history")
async def power_history(
    target: str = Query(default="", max_length=80),
    limit: int = Query(default=30, ge=1, le=200),
):
    try:
        return await asyncio.to_thread(get_device_power_history, target, limit)
    except DevicePowerError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error


async def _notify_owner_power_event(event: DevicePowerEventRequest) -> None:
    notify_url = os.getenv("LILY_OWNER_NOTIFY_URL", "").strip()
    notify_token = os.getenv("LILY_OWNER_NOTIFY_TOKEN", "").strip()
    if not notify_url or not notify_token:
        return
    label = event.target_label or event.target
    if event.state == "restart_complete":
        message = f"Sayang, {label} sudah online lagi setelah restart. Lily sudah cek sendiri, aman."
    elif event.state == "offline_confirmed":
        message = f"{label} sudah offline setelah {event.action}. Lily sudah konfirmasi statusnya."
    else:
        message = f"Lily belum bisa memastikan transisi {event.action} untuk {label}. Coba cek lagi lewat `/power status {event.target}`."
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.post(
                notify_url,
                headers={"X-Lily-Token": notify_token},
                json={"message": message, "priority": "normal", "source": "device_power"},
            )
            response.raise_for_status()
    except Exception as error:
        logger.warning("Owner power notification could not be delivered: %s", error)


@app.post("/api/power/events")
async def receive_power_event(
    event: DevicePowerEventRequest,
    x_lily_token: str | None = Header(default=None),
):
    expected = settings.tool_agent_token
    if not expected or not x_lily_token or not hmac.compare_digest(expected, x_lily_token):
        raise HTTPException(status_code=401, detail="Invalid Tool Vessel token.")
    payload = event.model_dump()
    event_id = core_state_store.publish(event.event_type, payload)
    asyncio.create_task(_notify_owner_power_event(event))
    return {"ok": True, "event_id": event_id}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.core_host, port=settings.core_port, timeout_graceful_shutdown=15)
