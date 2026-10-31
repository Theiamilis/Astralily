"""Request-scoped status events; never includes prompt text or partial replies."""
import asyncio
import logging
from contextvars import ContextVar
from functools import wraps

_current = ContextVar("lily_request_progress", default=None)
logger = logging.getLogger(__name__)


async def report_progress(phase: str) -> None:
    context = _current.get()
    if context is None:
        return
    store, request = context
    try:
        store.publish("request.progress", {
            "trace_id": request.trace_id,
            "session_id": request.session_id,
            "phase": phase,
        })
    except Exception:
        logger.warning("Could not publish request progress", exc_info=True)
    await asyncio.sleep(0)


def with_request_progress(method):
    @wraps(method)
    async def wrapped(self, request):
        self._ensure_trace(request)
        enabled = request.source in {"mobile_realm", "dashboard"} and request.mode in {"owner_chat", "language_practice"}
        context_handle = _current.set((self.state_store, request) if enabled else None)
        try:
            await report_progress("thinking")
            return await method(self, request)
        finally:
            _current.reset(context_handle)
    return wrapped
