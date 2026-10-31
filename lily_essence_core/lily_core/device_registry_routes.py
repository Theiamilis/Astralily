"""Owner-only device registry administration and invitation-based enrollment."""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from .device_registry import DeviceRegistryError, device_registry
from .settings import settings


router = APIRouter(prefix="/api/security", tags=["device-security"])


def _require_owner(
    request: Request,
    x_lily_owner_token: str = Header(default=""),
) -> None:
    if getattr(request.state, "device_principal", {}).get("role") == "owner":
        return
    authorization = request.headers.get("authorization", "").strip()
    provided = authorization[7:].strip() if authorization.lower().startswith("bearer ") else x_lily_owner_token
    if not settings.owner_api_token:
        raise HTTPException(status_code=503, detail="Owner API authentication is not configured.")
    if not hmac.compare_digest(provided, settings.owner_api_token):
        raise HTTPException(status_code=401, detail="Owner authentication required.")


def _result(action, *args, **kwargs):
    try:
        return action(*args, **kwargs)
    except DeviceRegistryError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


class InvitationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: str = "resident"
    scopes: list[str] = Field(default_factory=list, max_length=32)


class PairingRequestCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invitation_token: str = Field(min_length=32, max_length=128)
    name: str = Field(min_length=1, max_length=80)
    platform: str = Field(min_length=1, max_length=80)
    public_key_spki_b64: str = Field(min_length=80, max_length=1024)


class DeviceEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, max_length=80)
    role: str | None = None
    scopes: list[str] | None = Field(default=None, max_length=32)


class PairingApproval(BaseModel):
    model_config = ConfigDict(extra="forbid")
    verification_code: str = Field(pattern=r"^[0-9]{6}$")


@router.get("/devices", dependencies=[Depends(_require_owner)])
def list_devices():
    return {"devices": device_registry.list_devices()}


@router.get("/devices/history", dependencies=[Depends(_require_owner)])
def device_history():
    return {"events": device_registry.history()}


@router.patch("/devices/{device_id}", dependencies=[Depends(_require_owner)])
def edit_device(device_id: str, payload: DeviceEdit):
    if payload.name is None and payload.role is None and payload.scopes is None:
        raise HTTPException(status_code=400, detail="No device changes supplied.")
    return {"device": _result(device_registry.update_device, device_id, name=payload.name,
                              role=payload.role, scopes=payload.scopes)}


@router.post("/devices/{device_id}/revoke", dependencies=[Depends(_require_owner)])
def revoke_device(device_id: str):
    return {"device": _result(device_registry.revoke_device, device_id)}


@router.post("/pairing/invitations", dependencies=[Depends(_require_owner)])
def create_invitation(payload: InvitationCreate):
    return {"invitation": _result(device_registry.create_invitation, payload.role, payload.scopes)}


@router.post("/pairing/requests")
def submit_pairing_request(payload: PairingRequestCreate):
    return {"request": _result(device_registry.submit_request, payload.invitation_token,
                               payload.name, payload.platform, payload.public_key_spki_b64)}


@router.get("/pairing/requests/{request_id}/status")
def pairing_request_status(request_id: str):
    if len(request_id) != 32 or any(char not in "0123456789abcdef" for char in request_id):
        raise HTTPException(status_code=404, detail="Pairing request not found.")
    return {"request": _result(device_registry.request_status, request_id)}


@router.get("/pairing/requests", dependencies=[Depends(_require_owner)])
def list_pairing_requests():
    return {"requests": device_registry.list_requests()}


@router.post("/pairing/requests/{request_id}/approve", dependencies=[Depends(_require_owner)])
def approve_pairing_request(request_id: str, payload: PairingApproval):
    return {"request": _result(device_registry.decide_request, request_id, True, payload.verification_code)}


@router.post("/pairing/requests/{request_id}/deny", dependencies=[Depends(_require_owner)])
def deny_pairing_request(request_id: str):
    return {"request": _result(device_registry.decide_request, request_id, False)}


class SessionChallenge(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class SessionExchange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    challenge_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    signature: str = Field(min_length=80, max_length=256)


@router.post("/sessions/challenge")
def session_challenge(payload: SessionChallenge):
    from .device_sessions import device_sessions
    return _result(device_sessions.challenge, payload.device_id)


@router.post("/sessions/exchange")
def session_exchange(payload: SessionExchange):
    from .device_sessions import device_sessions
    return _result(device_sessions.exchange, payload.challenge_id, payload.signature)
