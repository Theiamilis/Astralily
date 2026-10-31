"""Small anonymous request surface; all approval decisions require the owner."""
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from .device_registry_routes import _require_owner, _result
from .settings import settings
from .vessel_pairing import VesselPairing

router = APIRouter(prefix='/api/security/vessels', tags=['vessel-pairing'])
registry = VesselPairing(settings.runtime_settings_path.parent / 'vessel-pairing' / 'registry.sqlite3', settings)


class Join(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=80, pattern=r'^[^\x00-\x1f]+$')
    service: str = Field(max_length=30)
    host: str = Field(min_length=2, max_length=64)
    port: int = Field(ge=1024, le=65535)
    public_key: str = Field(min_length=100, max_length=1024)


class Approval(BaseModel):
    model_config = ConfigDict(extra='forbid')
    code: str = Field(pattern=r'^[a-fA-F0-9]{12}$')


class Proof(BaseModel):
    model_config = ConfigDict(extra='forbid')
    proof: str = Field(pattern=r'^[a-f0-9]{64}$')


@router.post('/requests')
def submit(payload: Join, request: Request):
    return {'request': _result(registry.submit, payload.model_dump(), request.client.host if request.client else '')}


@router.get('/requests', dependencies=[Depends(_require_owner)])
def listing():
    return {'requests': registry.list()}


@router.get('/requests/{rid}/status')
def status(rid: str):
    return {'request': _result(registry.status, rid)}


@router.post('/requests/{rid}/activate')
def activate(rid: str, payload: Proof):
    return {'request': _result(registry.activate, rid, payload.proof)}


@router.post('/requests/{rid}/approve', dependencies=[Depends(_require_owner)])
def approve(rid: str, payload: Approval):
    return {'request': _result(registry.decide, rid, 'approve', payload.code)}


@router.post('/requests/{rid}/deny', dependencies=[Depends(_require_owner)])
def deny(rid: str):
    return {'request': _result(registry.decide, rid, 'deny')}


@router.post('/requests/{rid}/revoke', dependencies=[Depends(_require_owner)])
def revoke(rid: str):
    return {'request': _result(registry.decide, rid, 'revoke')}
