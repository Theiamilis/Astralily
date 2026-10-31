from __future__ import annotations

import os
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .registry import ASSIGNMENT_TARGETS, SEMANTIC_OPTIONS, ModelRegistry, ModelRegistryError
from .network_security import require_token_for_non_loopback
from .schemas import AssignmentRequest, ExpressionMappingRequest, RenameModelRequest
from .settings import settings


def _origins() -> list[str]:
    raw = settings.cors_allow_origins
    environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
    development = environment in {"development", "dev", "local"}
    if not raw:
        return ["*"] if development else []
    if raw == "*":
        return ["*"] if development else []
    return [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]


def _require_token(
    authorization: str | None = Header(default=None),
    x_lily_model_token: str | None = Header(default=None),
) -> None:
    if not settings.token:
        environment = os.getenv("LILY_ENVIRONMENT", "development").strip().lower()
        if environment not in {"development", "dev", "local"}:
            raise HTTPException(status_code=503, detail="Model Vessel service token is not configured.")
        return
    bearer = ""
    if authorization and authorization.lower().startswith("bearer "):
        bearer = authorization.split(" ", 1)[1].strip()
    if bearer == settings.token or x_lily_model_token == settings.token:
        return
    raise HTTPException(status_code=401, detail="Missing or invalid Model Vessel token.")


registry = ModelRegistry(
    settings.asset_root,
    settings.database_path,
    settings.max_unpacked_bytes,
    settings.max_archive_files,
)
app = FastAPI(title="Lily Model Vessel", version="0.1.0")

# Report the build actually loaded by this service, independently of later file updates.
import runpy as _runtime_runpy
from pathlib import Path as _RuntimePath
_runtime_runpy.run_path(str(_RuntimePath(__file__).resolve().parents[2] / "scripts" / "runtime_status.py"))["install_tracking"](app, "model_vessel")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins(),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/models", StaticFiles(directory=settings.asset_root), name="live2d-models")


@app.on_event("startup")
def validate_network_security() -> None:
    require_token_for_non_loopback(settings.host, settings.token, "Model Vessel")


@app.exception_handler(ModelRegistryError)
async def model_registry_error_handler(_request: Request, error: ModelRegistryError):
    return JSONResponse(status_code=error.status_code, content={"detail": error.detail})


def _with_urls(request: Request, model: dict) -> dict:
    payload = dict(model)
    base = settings.public_base_url or str(request.base_url).rstrip("/")
    model_id = payload["model_id"]
    payload["asset_url"] = f"{base}/models/{model_id}/"
    payload["model_url"] = f"{base}/models/{model_id}/{payload['model_json_path']}"
    return payload


@app.get("/api/auth/check")
def credential_check(x_lily_token: str | None = Header(default=None)) -> dict:
    """Cheap authenticated probe for credential rotation; never runs a model."""
    import hmac
    if not settings.token or not hmac.compare_digest(x_lily_token or "", settings.token):
        raise HTTPException(status_code=401, detail="Invalid service credential")
    return {"authenticated": True, "service": "model"}


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "lily_model_vessel",
    }


@app.get("/api/health")
def detailed_health(_auth: None = Depends(_require_token)) -> dict:
    return {
        "status": "ok",
        "service": "lily_model_vessel",
        "models": len(registry.list_models()),
        "asset_root": str(settings.asset_root),
    }


@app.get("/api/models")
def list_models(request: Request) -> dict:
    return {
        "models": [_with_urls(request, model) for model in registry.list_models()],
        "assignments": registry.assignments(),
        "semantic_options": list(SEMANTIC_OPTIONS),
        "assignment_targets": list(ASSIGNMENT_TARGETS),
    }


@app.get("/api/models/{model_id}")
def get_model(model_id: str, request: Request) -> dict:
    return _with_urls(request, registry.get_model(model_id))


@app.post("/api/models/upload")
async def upload_model(
    request: Request,
    archive: UploadFile = File(...),
    display_name: str | None = Form(default=None),
    _auth: None = Depends(_require_token),
) -> dict:
    if not (archive.filename or "").lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Upload a ZIP archive containing one Live2D model.")
    data = await archive.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="The model archive exceeds the configured upload limit.")
    model = registry.install_zip(data, archive.filename or "live2d-model.zip", display_name)
    return _with_urls(request, model)


@app.patch("/api/models/{model_id}")
def rename_model(
    model_id: str,
    body: RenameModelRequest,
    request: Request,
    _auth: None = Depends(_require_token),
) -> dict:
    return _with_urls(request, registry.rename_model(model_id, body.display_name))


@app.put("/api/models/{model_id}/expressions")
def update_expressions(
    model_id: str,
    body: ExpressionMappingRequest,
    request: Request,
    _auth: None = Depends(_require_token),
) -> dict:
    updates = [item.model_dump() for item in body.expressions]
    return _with_urls(request, registry.update_expressions(model_id, updates))


@app.post("/api/models/{model_id}/select")
def select_model(
    model_id: str,
    body: AssignmentRequest,
    request: Request,
    _auth: None = Depends(_require_token),
) -> dict:
    return _with_urls(request, registry.assign(body.target, model_id))


@app.get("/api/assignments")
def list_assignments() -> dict:
    return {"assignments": registry.assignments()}


@app.get("/api/assignments/{target}")
def resolve_assignment(target: str, request: Request) -> dict:
    return _with_urls(request, registry.resolve_assignment(target))


@app.delete("/api/models/{model_id}")
def delete_model(model_id: str, _auth: None = Depends(_require_token)) -> dict:
    registry.delete_model(model_id)
    return {"status": "deleted", "model_id": model_id}
