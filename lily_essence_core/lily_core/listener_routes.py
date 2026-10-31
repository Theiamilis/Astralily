"""Owner-only controls for explicitly registered microphone listeners."""
from __future__ import annotations

import json
import hmac
from typing import Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError

from .runtime_settings import update_runtime_settings
from .settings import settings


def _require_owner(request: Request) -> None:
    authorization = request.headers.get("authorization", "").strip()
    provided = authorization[7:].strip() if authorization.lower().startswith("bearer ") else request.headers.get("x-lily-owner-token", "").strip()
    if not settings.owner_api_token:
        raise HTTPException(status_code=503, detail="Owner API authentication is not configured.")
    if not hmac.compare_digest(provided, settings.owner_api_token):
        raise HTTPException(status_code=401, detail="Owner authentication required.")


router = APIRouter(prefix="/api/listeners", tags=["listeners"], dependencies=[Depends(_require_owner)])


class ListenerNode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern="^[a-z0-9][a-z0-9_-]{0,63}$")
    label: str = Field(default="", max_length=80)
    url: str = Field(min_length=1, max_length=500)
    token: SecretStr = Field(min_length=1, max_length=512)


class ListenerRegistryEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern="^[a-z0-9][a-z0-9_-]{0,63}$")
    label: str = Field(default="", max_length=80)
    url: str = Field(min_length=1, max_length=500)
    token: SecretStr | None = Field(default=None, max_length=512)


class ListenerRegistryUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    listeners: list[ListenerRegistryEntry] = Field(max_length=16)


class ListenerOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    input_device: int | None = Field(default=None, ge=0)
    output_device: int | None = Field(default=None, ge=0)
    activation: Literal["clap_or_phrase", "clap_phrase", "clap"] = "clap_or_phrase"
    clap_peak: float = Field(default=0.35, ge=0.05, le=0.95)
    speech_rms: float = Field(default=0.015, ge=0.001, le=0.2)
    silence_seconds: float = Field(default=0.9, ge=0.4, le=3)
    input_language: str = Field(default="auto", pattern="^(auto|[a-z]{2})$")
    voice_language: Literal["en", "ja"] = "en"
    voice_profile: Literal["en", "ja"] = "en"


class ListenerCaller(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_id: str = Field(default="control_center", pattern="^[a-z0-9][a-z0-9_-]{0,39}$")


def parse_node_registry(raw: str) -> list[ListenerNode]:
    try:
        if len(raw) > 64_000:
            raise ValueError("Invalid registry size")
        decoded = json.loads(raw)
        if not isinstance(decoded, list) or len(decoded) > 16:
            raise ValueError("Invalid registry size")
        result = [ListenerNode.model_validate(item) for item in decoded]
        if len({item.id for item in result}) != len(result):
            raise ValueError("Duplicate listener IDs")
        for item in result:
            url = urlsplit(item.url)
            try:
                url.port
            except ValueError:
                raise ValueError("Invalid listener URL") from None
            if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
                raise ValueError("Invalid listener URL")
            if not item.token.get_secret_value():
                raise ValueError("Missing listener token")
        return result
    except (ValueError, TypeError):
        raise ValueError("Listener registry is invalid. Check its device IDs, URLs and tokens.") from None


def nodes() -> list[ListenerNode]:
    try:
        return parse_node_registry(settings.listener_nodes_json)
    except ValueError:
        raise HTTPException(503, "Listener registry is invalid. Check LILY_LISTENER_NODES or the saved Listener settings.") from None


def registry_snapshot(items: list[ListenerNode] | None = None) -> dict:
    registered = items if items is not None else nodes()
    return {"listeners": [{"id": item.id, "label": item.label or item.id, "url": item.url,
                           "token_configured": bool(item.token.get_secret_value())} for item in registered]}


async def forward(node_id: str, path: str, method: str = "GET", body: dict | None = None) -> dict:
    node = next((item for item in nodes() if item.id == node_id), None)
    if node is None:
        raise HTTPException(404, "Listener device is not registered.")
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client:
            response = await client.request(method, f"{node.url.rstrip('/')}/api/listener/{path}",
                                            headers={"Authorization": f"Bearer {node.token.get_secret_value()}"}, json=body)
        if response.status_code >= 400:
            raise HTTPException(response.status_code if response.status_code in {409, 422, 503} else 502,
                                "Listener rejected the request. Check its token, state and audio configuration.")
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("Invalid response")
        if path != "devices" and data.get("device_id") != node.id:
            raise ValueError("Listener identity mismatch")
        return data
    except (httpx.HTTPError, ValueError):
        raise HTTPException(502, "Listener is unreachable or returned an invalid response.") from None


@router.get("")
async def list_listeners():
    return {"listeners": [{"id": node.id, "label": node.label or node.id} for node in nodes()]}


@router.get("/registry")
async def get_listener_registry():
    return registry_snapshot()


@router.put("/registry")
async def update_listener_registry(request: Request):
    body = await request.body()
    if len(body) > 64_000:
        raise HTTPException(413, "Listener registry is too large.")
    try:
        update = ListenerRegistryUpdate.model_validate_json(body)
    except (ValidationError, ValueError):
        raise HTTPException(422, "Invalid Listener registry payload. Check IDs, URLs and required fields.") from None

    existing = {node.id: node for node in nodes()}
    registry: list[dict[str, str]] = []
    for entry in update.listeners:
        token = entry.token.get_secret_value().strip() if entry.token is not None else ""
        if not token and entry.id in existing:
            token = existing[entry.id].token.get_secret_value()
        if not token:
            raise HTTPException(422, "Enter the Listener service token from that device's .env file.")
        registry.append({"id": entry.id, "label": entry.label, "url": entry.url, "token": token})

    serialized = json.dumps(registry, ensure_ascii=False, separators=(",", ":"))
    try:
        parsed = parse_node_registry(serialized)
        update_runtime_settings(settings, {"listener_nodes_json": serialized})
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    return registry_snapshot(parsed)


@router.get("/{node_id}/status")
async def listener_status(node_id: str):
    return await forward(node_id, "status")


@router.get("/{node_id}/devices")
async def listener_devices(node_id: str):
    return await forward(node_id, "devices")


@router.put("/{node_id}/options")
async def listener_options(node_id: str, options: ListenerOptions):
    return await forward(node_id, "options", "PUT", options.model_dump())


@router.post("/{node_id}/{action}")
async def listener_action(node_id: str, action: Literal["enable", "pause", "cancel", "listen", "test-greeting"], caller: ListenerCaller):
    return await forward(node_id, action, "POST", caller.model_dump())
