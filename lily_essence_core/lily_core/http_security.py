from __future__ import annotations

import asyncio
import hashlib
import json
import os
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class RequestBodyTooLarge(Exception):
    pass


def _env_bytes(name: str, fallback: int) -> int:
    try:
        return max(1024, int(os.getenv(name, str(fallback))))
    except ValueError:
        return fallback


def body_limit_for_path(path: str) -> int:
    if path.startswith("/api/security/"):
        return _env_bytes("LILY_HTTP_SECURITY_MAX_BODY_BYTES", 16 * 1024)
    if path.startswith("/api/family/"):
        return _env_bytes("LILY_HTTP_FAMILY_MAX_BODY_BYTES", 64 * 1024)
    if path in {"/api/stt/transcribe", "/api/stt/transcribe/local"}:
        return _env_bytes("LILY_HTTP_STT_MAX_BODY_BYTES", 12 * 1024 * 1024)
    if path == "/api/stream-stage/vision":
        return _env_bytes("LILY_HTTP_VISION_MAX_BODY_BYTES", 16 * 1024 * 1024)
    if path.startswith("/api/finance/"):
        return _env_bytes("LILY_HTTP_FINANCE_MAX_BODY_BYTES", 8 * 1024 * 1024)
    return _env_bytes("LILY_HTTP_DEFAULT_MAX_BODY_BYTES", 2 * 1024 * 1024)


class RequestBodyLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = body_limit_for_path(str(scope.get("path") or ""))
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        raw_length = headers.get(b"content-length", b"").decode("ascii", errors="ignore")
        try:
            if raw_length and int(raw_length) > limit:
                await JSONResponse(
                    status_code=413,
                    content={"detail": "Request body exceeds the configured limit."},
                )(scope, receive, send)
                return
        except ValueError:
            await JSONResponse(status_code=400, content={"detail": "Invalid Content-Length header."})(
                scope, receive, send
            )
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise RequestBodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except RequestBodyTooLarge:
            await JSONResponse(
                status_code=413,
                content={"detail": "Request body exceeds the configured limit."},
            )(scope, receive, send)


def rate_limit_for_request(method: str, path: str) -> tuple[int, int] | None:
    if method.upper() == "OPTIONS" or path.startswith("/static/"):
        return None
    if path in {"/health/live", "/health/ready"}:
        return (120, 60)
    if method.upper() == "POST" and path in {"/api/security/pairing/requests", "/api/security/vessels/requests", "/api/security/sessions/challenge", "/api/security/sessions/exchange"}:
        return (5, 60)
    if method.upper() == "POST" and path in {"/api/family/pairing/requests", "/api/family/sessions/challenge", "/api/family/sessions/exchange"}:
        return (5, 60)
    if path.startswith("/api/family/"):
        return (30, 60)
    if path.startswith("/api/security/"):
        return (30, 60)
    if path == "/api/power/wake" or path.startswith("/api/device-power/"):
        return (6, 60)
    if path == "/api/stream-stage/vision":
        return (12, 60)
    if path in {"/api/stt/transcribe", "/api/stt/transcribe/local"}:
        return (20, 60)
    if path.startswith("/api/openclaw/") or path.startswith("/api/tools/"):
        return (30, 60)
    if path.startswith("/api/home/") or path.startswith("/api/finance/"):
        return (60, 60)
    if path in {"/api/chat", "/api/chat/stream", "/api/core/ingest"}:
        return (90, 60)
    if method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
        return (120, 60)
    return None


def rate_limit_bucket_path(path: str) -> str:
    for prefix in (
        "/api/device-power/", "/api/tools/", "/api/openclaw/", "/api/home/", "/api/finance/"
    ):
        if path.startswith(prefix):
            return prefix + "*"
    return path


class SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = {}
        self._lock = asyncio.Lock()

    async def check(self, bucket: str, limit: int, window_seconds: int) -> tuple[bool, int]:
        now = time.monotonic()
        cutoff = now - window_seconds
        async with self._lock:
            events = self._events.setdefault(bucket, deque())
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= limit:
                retry_after = max(1, int(window_seconds - (now - events[0])) + 1)
                return False, retry_after
            events.append(now)
            if len(self._events) > 4096:
                for key, value in list(self._events.items()):
                    while value and value[0] <= cutoff:
                        value.popleft()
                    if not value:
                        del self._events[key]
                if len(self._events) > 4096:
                    oldest = min(self._events, key=lambda key: self._events[key][-1])
                    del self._events[oldest]
            return True, 0


def new_request_id() -> str:
    return uuid.uuid4().hex


def actor_fingerprint(token: str) -> str:
    if not token:
        return "anonymous"
    return "token:" + hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]


def audit_route(path: str) -> str:
    for prefix in (
        "/api/finance/",
        "/api/home/",
        "/api/openclaw/",
        "/api/device-power/",
        "/api/models/",
    ):
        if path.startswith(prefix):
            return prefix + "*"
    return path[:160]


class SecurityAuditLog:
    def __init__(self, path: Path, max_bytes: int = 5 * 1024 * 1024) -> None:
        self.path = path
        self.max_bytes = max(64 * 1024, max_bytes)
        self._lock = threading.Lock()

    def write(
        self,
        *,
        event: str,
        request_id: str,
        method: str,
        path: str,
        status: int,
        client: str,
        actor: str,
        duration_ms: int = 0,
    ) -> None:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "request_id": request_id,
            "method": method.upper(),
            "route": audit_route(path),
            "status": int(status),
            "client": client,
            "actor": actor,
            "duration_ms": max(0, int(duration_ms)),
        }
        encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n"
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.exists() and self.path.stat().st_size >= self.max_bytes:
                archive = self.path.with_suffix(self.path.suffix + ".1")
                archive.unlink(missing_ok=True)
                self.path.replace(archive)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(encoded)


def default_security_audit_log(core_dir: Path) -> SecurityAuditLog:
    raw_path = os.getenv("LILY_SECURITY_AUDIT_PATH", "runtime/security_audit.jsonl").strip()
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = core_dir / path
    try:
        max_bytes = int(os.getenv("LILY_SECURITY_AUDIT_MAX_BYTES", str(5 * 1024 * 1024)))
    except ValueError:
        max_bytes = 5 * 1024 * 1024
    return SecurityAuditLog(path, max_bytes)
