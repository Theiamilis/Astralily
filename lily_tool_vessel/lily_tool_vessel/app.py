import asyncio
import json
import logging
import os
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from lily_tool_vessel.artifacts import collect_artifacts
from lily_tool_vessel.device_power import (
    DevicePowerError,
    append_power_audit,
    execute_device_power,
    get_device_power_status,
    list_power_targets,
    read_power_history,
)
from lily_tool_vessel.providers import get_provider_health, run_provider_with_fallback
from lily_tool_vessel.network_security import require_token_for_non_loopback
from lily_tool_vessel.schemas import (
    DevicePowerHistoryResponse,
    DevicePowerRequest,
    DevicePowerResponse,
    DevicePowerStatus,
    DevicePowerWatcher,
    ToolRunRequest,
    ToolRunResponse,
)
from lily_tool_vessel.settings import settings


HOST = settings.host
PORT = settings.port

logging.basicConfig(level=logging.INFO, format="[Lily Tool Vessel] %(message)s")
logger = logging.getLogger("lily_tool_vessel")


def _cors_allow_origins() -> list[str]:
    raw_origins = os.getenv("LILY_TOOL_CORS_ALLOW_ORIGINS", os.getenv("LILY_CORS_ALLOW_ORIGINS", "")).strip()
    environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
    development = environment in {"development", "dev", "local"}
    if not raw_origins:
        return ["*"] if development else []
    if raw_origins == "*":
        return ["*"] if development else []
    return [origin.strip().rstrip("/") for origin in raw_origins.split(",") if origin.strip()]


app = FastAPI(title="Lily Tool Vessel", version="0.1.0")

# Report the build actually loaded by this service, independently of later file updates.
import runpy as _runtime_runpy
from pathlib import Path as _RuntimePath
_runtime_runpy.run_path(str(_RuntimePath(__file__).resolve().parents[2] / "scripts" / "runtime_status.py"))["install_tracking"](app, "tool_vessel")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def validate_network_security() -> None:
    require_token_for_non_loopback(settings.host, settings.token, "Tool Vessel")

_tool_lock = asyncio.Lock()
_device_power_lock = asyncio.Lock()
_device_power_watchers: dict[str, dict[str, Any]] = {}
_device_power_watcher_tasks: set[asyncio.Task[Any]] = set()
_state: dict[str, Any] = {
    "active": False,
    "last_provider": "",
    "last_error": "",
    "last_duration_ms": 0,
    "last_completed_at": None,
}


def _require_token(x_lily_token: str | None) -> None:
    if not settings.token:
        environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
        if environment not in {"development", "dev", "local"}:
            raise HTTPException(status_code=503, detail="Tool Vessel service token is not configured.")
        return
    if x_lily_token != settings.token:
        raise HTTPException(status_code=401, detail="Invalid Lily tool vessel token.")


def _state_snapshot() -> dict[str, Any]:
    return dict(_state)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _post_power_event(payload: dict[str, Any]) -> None:
    if not settings.device_power_event_url:
        return
    headers = {"Content-Type": "application/json"}
    if settings.token:
        headers["X-Lily-Token"] = settings.token
    request = urllib.request.Request(
        settings.device_power_event_url,
        data=json.dumps(payload, ensure_ascii=True).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        response.read()


async def _finish_power_watcher(watcher_id: str, state: str, detail: str) -> None:
    watcher = _device_power_watchers.get(watcher_id)
    if not watcher:
        return
    watcher.update({"state": state, "detail": detail, "updated_at": _utc_now()})
    record = append_power_audit(
        settings,
        {
            "event": "watcher",
            "watcher_id": watcher_id,
            "target": watcher["target_id"],
            "target_label": watcher["target_label"],
            "action": watcher["action"],
            "state": state,
            "detail": detail,
            "ok": state in {"offline_confirmed", "restart_complete"},
        },
    )
    try:
        await asyncio.to_thread(_post_power_event, {"event_type": "device_power.transition", **record})
    except Exception as error:
        logger.warning("Power watcher event callback failed: %s", error)


async def _watch_power_transition(watcher_id: str) -> None:
    watcher = _device_power_watchers[watcher_id]
    deadline = time.monotonic() + max(30, settings.device_power_watcher_timeout_seconds)
    offline_seen = False
    while time.monotonic() < deadline:
        await asyncio.sleep(settings.device_power_watcher_poll_seconds)
        status = await asyncio.to_thread(get_device_power_status, watcher["target_id"], settings)
        watcher["updated_at"] = _utc_now()
        watcher["last_online"] = status.online
        if not status.online:
            offline_seen = True
            watcher["state"] = "waiting_online" if watcher["action"] == "restart" else "offline_confirmed"
            if watcher["action"] != "restart":
                await _finish_power_watcher(
                    watcher_id,
                    "offline_confirmed",
                    f"{watcher['target_label']} is offline after {watcher['action']}.",
                )
                return
        elif watcher["action"] == "restart" and offline_seen:
            await _finish_power_watcher(
                watcher_id,
                "restart_complete",
                f"{watcher['target_label']} is back online after restart.",
            )
            return

    await _finish_power_watcher(
        watcher_id,
        "timed_out",
        f"Lily could not confirm the {watcher['action']} transition for {watcher['target_label']} in time.",
    )


def _start_power_watcher(result: DevicePowerResponse) -> None:
    if result.action not in {"shutdown", "restart", "hibernate"}:
        return
    watcher_id = f"watch_{uuid.uuid4().hex[:10]}"
    now = _utc_now()
    _device_power_watchers[watcher_id] = {
        "id": watcher_id,
        "target_id": result.target_id,
        "target_label": result.target_label,
        "action": result.action,
        "state": "waiting_offline",
        "started_at": now,
        "updated_at": now,
        "detail": "Waiting for the target state transition.",
    }
    append_power_audit(
        settings,
        {
            "event": "watcher",
            "watcher_id": watcher_id,
            "target": result.target_id,
            "target_label": result.target_label,
            "action": result.action,
            "state": "started",
            "ok": True,
        },
    )
    task = asyncio.create_task(_watch_power_transition(watcher_id))
    _device_power_watcher_tasks.add(task)
    task.add_done_callback(_device_power_watcher_tasks.discard)


def _artifact_root() -> Path:
    root = Path(settings.artifact_dir).expanduser()
    if not root.is_absolute():
        root = (Path(__file__).resolve().parents[1] / root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


@app.get("/api/auth/check")
def credential_check(x_lily_token: str | None = Header(default=None)) -> dict:
    """Cheap authenticated probe for credential rotation; never runs a model."""
    import hmac
    if not settings.token or not hmac.compare_digest(x_lily_token or "", settings.token):
        raise HTTPException(status_code=401, detail="Invalid service credential")
    return {"authenticated": True, "service": "tool"}


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "lily_tool_vessel",
        "mode": "tool-vessel",
    }


@app.get("/api/health")
def detailed_health(x_lily_token: str | None = Header(default=None)) -> dict[str, Any]:
    _require_token(x_lily_token)
    payload = get_provider_health(settings)
    payload["mode"] = "tool-vessel"
    payload["queue"] = _state_snapshot()
    payload["artifacts"] = {
        "dir": str(_artifact_root()),
        "max_bytes": settings.artifact_max_bytes,
        "allowed_extensions": settings.artifact_allowed_extensions,
    }
    payload["inputs"] = {
        "max_bytes": settings.input_max_bytes,
        "allowed_extensions": settings.input_allowed_extensions,
    }
    targets = list_power_targets(settings)
    payload["device_power"] = {
        "enabled_targets": [target["id"] for target in targets if target["enabled"]],
        "registered_targets": [target["id"] for target in targets],
        "confirmation_required": True,
    }
    return payload


@app.get("/api/device-power/targets")
def device_power_targets(x_lily_token: str | None = Header(default=None)) -> dict[str, Any]:
    _require_token(x_lily_token)
    targets = list_power_targets(settings)
    return {
        "targets": [
            {
                "id": target["id"],
                "label": target["label"],
                "enabled": target["enabled"],
                "default": target["default"],
                "allowed_actions": target["allowed_actions"],
            }
            for target in targets
        ]
    }


@app.get("/api/device-power/status")
async def device_power_status(
    target: str = Query(default="", max_length=80),
    x_lily_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_token(x_lily_token)
    targets = list_power_targets(settings)
    selected = [item for item in targets if item["enabled"]]
    if target.strip():
        normalized = target.strip().lower()
        selected = [
            item for item in selected
            if normalized in {item["id"].lower(), item["label"].lower(), item["host"].lower(), *(alias.lower() for alias in item["aliases"])}
        ]
        if not selected:
            raise HTTPException(status_code=404, detail="The requested power target is not registered.")
    statuses = await asyncio.gather(
        *(asyncio.to_thread(get_device_power_status, item["id"], settings) for item in selected)
    )
    return {"devices": [item.model_dump() for item in statuses], "count": len(statuses)}


@app.get("/api/device-power/history", response_model=DevicePowerHistoryResponse)
async def device_power_history(
    limit: int = Query(default=30, ge=1, le=200),
    target: str = Query(default="", max_length=80),
    x_lily_token: str | None = Header(default=None),
) -> DevicePowerHistoryResponse:
    _require_token(x_lily_token)
    items = await asyncio.to_thread(read_power_history, settings, limit=limit, target=target)
    return DevicePowerHistoryResponse(items=items, count=len(items))


@app.get("/api/device-power/watchers")
def device_power_watchers(x_lily_token: str | None = Header(default=None)) -> dict[str, Any]:
    _require_token(x_lily_token)
    items = [DevicePowerWatcher(**item).model_dump() for item in _device_power_watchers.values()]
    items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
    return {"items": items[:30], "count": len(items)}


@app.post("/api/device-power/run", response_model=DevicePowerResponse)
async def run_device_power(
    payload: DevicePowerRequest,
    x_lily_token: str | None = Header(default=None),
) -> DevicePowerResponse:
    _require_token(x_lily_token)
    async with _device_power_lock:
        try:
            result = await asyncio.to_thread(execute_device_power, payload, settings)
            _start_power_watcher(result)
            return result
        except DevicePowerError as error:
            logger.warning("Device power request rejected: %s", error)
            raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/api/tool/artifacts/{run_id}/{artifact_id}")
def download_artifact(
    run_id: str,
    artifact_id: str,
    x_lily_token: str | None = Header(default=None),
) -> FileResponse:
    _require_token(x_lily_token)
    safe_run_id = run_id.strip()
    safe_artifact_id = artifact_id.strip()
    if not safe_run_id or "/" in safe_run_id or "\\" in safe_run_id or safe_run_id.startswith("."):
        raise HTTPException(status_code=404, detail="Artifact run was not found.")

    run_dir = (_artifact_root() / safe_run_id).resolve()
    try:
        run_dir.relative_to(_artifact_root().resolve())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Artifact run was not found.") from exc

    for provider_dir in sorted(run_dir.iterdir()) if run_dir.is_dir() else []:
        if not provider_dir.is_dir() or provider_dir.name == "inputs":
            continue
        for artifact in collect_artifacts(provider_dir, settings, safe_run_id, include_path=True):
            if artifact["id"] != safe_artifact_id:
                continue

            return FileResponse(
                str(artifact["storage_path"]),
                media_type=artifact["mime_type"],
                filename=artifact["name"],
            )

    raise HTTPException(status_code=404, detail="Artifact was not found.")


@app.get("/api/tool/artifacts/{run_id}")
def list_artifacts(
    run_id: str,
    x_lily_token: str | None = Header(default=None),
) -> dict[str, Any]:
    _require_token(x_lily_token)
    safe_run_id = run_id.strip()
    if not safe_run_id or "/" in safe_run_id or "\\" in safe_run_id or safe_run_id.startswith("."):
        raise HTTPException(status_code=404, detail="Artifact run was not found.")

    root = _artifact_root().resolve()
    run_dir = (root / safe_run_id).resolve()
    try:
        run_dir.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Artifact run was not found.") from exc
    if not run_dir.is_dir():
        raise HTTPException(status_code=404, detail="Artifact run was not found.")

    artifacts: list[dict[str, Any]] = []
    for provider_dir in sorted(run_dir.iterdir()):
        if not provider_dir.is_dir() or provider_dir.name == "inputs":
            continue
        artifacts.extend(collect_artifacts(provider_dir, settings, safe_run_id))
    return {"ok": True, "run_id": safe_run_id, "artifacts": artifacts}


@app.post("/api/tool/run", response_model=ToolRunResponse)
async def run_tool(
    payload: ToolRunRequest,
    x_lily_token: str | None = Header(default=None),
) -> ToolRunResponse:
    _require_token(x_lily_token)
    provider = (payload.provider or settings.provider or "hermes").strip().lower()
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    payload = payload.model_copy(update={"artifact_dir": str(_artifact_root() / run_id)})
    started_at = time.perf_counter()

    async with _tool_lock:
        _state["active"] = True
        _state["last_provider"] = provider
        _state["last_error"] = ""

        try:
            result = await run_provider_with_fallback(payload, settings)
            duration_ms = int((time.perf_counter() - started_at) * 1000)
            _state["last_duration_ms"] = duration_ms
            _state["last_completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            _state["last_provider"] = result["provider"]
            if not result["ok"]:
                _state["last_error"] = result["error"]
                logger.error("Tool task failed: %s", result["error"])
                return ToolRunResponse(
                    ok=False,
                    status="failed",
                    provider=result["provider"],
                    error=result["error"],
                    duration_ms=duration_ms,
                    requested_provider=result["requested_provider"],
                    fallback_used=result["fallback_used"],
                    provider_attempts=result["provider_attempts"],
                    artifacts=result.get("artifacts", []),
                )

            return ToolRunResponse(
                ok=True,
                status="completed",
                provider=result["provider"],
                result_text=result["result_text"],
                duration_ms=duration_ms,
                requested_provider=result["requested_provider"],
                fallback_used=result["fallback_used"],
                provider_attempts=result["provider_attempts"],
                artifacts=result.get("artifacts", []),
            )
        except Exception as error:
            duration_ms = int((time.perf_counter() - started_at) * 1000)
            _state["last_error"] = str(error)
            _state["last_duration_ms"] = duration_ms
            _state["last_completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            logger.error("Tool task failed: %s", error)
            return ToolRunResponse(
                ok=False,
                status="failed",
                provider=provider,
                error=str(error),
                duration_ms=duration_ms,
            )
        finally:
            _state["active"] = False


@app.post("/run", response_model=ToolRunResponse)
async def run_tool_alias(
    payload: ToolRunRequest,
    x_lily_token: str | None = Header(default=None),
) -> ToolRunResponse:
    return await run_tool(payload, x_lily_token)


if __name__ == "__main__":
    uvicorn.run("lily_tool_vessel.app:app", host=HOST, port=PORT)
