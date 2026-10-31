from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


_SIGNING_SECRET = (
    os.getenv("LILY_AUDIO_URL_SIGNING_SECRET", "").strip()
    or os.getenv("LILY_OWNER_API_TOKEN", "").strip()
    or secrets.token_urlsafe(32)
).encode("utf-8")
_DEFAULT_TTL_SECONDS = max(30, int(os.getenv("LILY_AUDIO_URL_TTL_SECONDS", "900")))
_PRUNE_LOCK = Lock()
_last_prune_at = 0.0


def prune_core_audio_cache(
    directory: Path,
    *,
    now: float | None = None,
    max_age_seconds: int = 7 * 86400,
    max_bytes: int = 512 * 1024 * 1024,
    force: bool = False,
) -> int:
    """Bound generated audio without removing files whose signed URLs may still be live."""
    global _last_prune_at
    current = time.time() if now is None else now
    with _PRUNE_LOCK:
        if not force and current - _last_prune_at < 60:
            return 0
        _last_prune_at = current
        if not directory.is_dir():
            return 0
        files: list[tuple[float, int, Path]] = []
        removed = 0
        for path in directory.iterdir():
            if not path.is_file() or path.suffix.lower() not in {".wav", ".ogg", ".mp3"}:
                continue
            try:
                stat = path.stat()
                if current - stat.st_mtime > max_age_seconds:
                    path.unlink()
                    removed += 1
                else:
                    files.append((stat.st_mtime, stat.st_size, path))
            except OSError:
                continue
        total = sum(size for _, size, _ in files)
        for mtime, size, path in sorted(files):
            if total <= max_bytes:
                break
            if current - mtime < max(_DEFAULT_TTL_SECONDS * 2, 3600):
                continue
            try:
                path.unlink()
                total -= size
                removed += 1
            except OSError:
                continue
        return removed


def _safe_audio_name(value: str) -> str:
    name = Path(value).name
    if not name or name != value or name.startswith("."):
        return ""
    return name


def _signature(filename: str, expires: int) -> str:
    message = f"{filename}:{expires}".encode("utf-8")
    return hmac.new(_SIGNING_SECRET, message, hashlib.sha256).hexdigest()


def sign_core_audio_url(
    value: str | None,
    *,
    now: int | None = None,
    ttl_seconds: int | None = None,
) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlsplit(raw)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith("/static/audio/"):
        return raw
    filename = _safe_audio_name(parsed.path.removeprefix("/static/audio/"))
    if not filename:
        return ""
    expires = int(now if now is not None else time.time()) + max(1, ttl_seconds or _DEFAULT_TTL_SECONDS)
    query = dict(parse_qsl(parsed.query, keep_blank_values=False))
    query.update({"expires": str(expires), "signature": _signature(filename, expires)})
    return urlunsplit(("", "", parsed.path, urlencode(query), ""))


def verify_core_audio_url(
    filename: str,
    expires: str | None,
    signature: str | None,
    *,
    now: int | None = None,
) -> str:
    safe_name = _safe_audio_name(filename)
    if not safe_name:
        return "invalid"
    try:
        expiry = int(str(expires or ""))
    except ValueError:
        return "invalid"
    current = int(now if now is not None else time.time())
    if expiry < current:
        return "expired"
    if expiry > current + max(_DEFAULT_TTL_SECONDS * 2, 3600):
        return "invalid"
    expected = _signature(safe_name, expiry)
    if not signature or not hmac.compare_digest(str(signature), expected):
        return "invalid"
    return "ok"
