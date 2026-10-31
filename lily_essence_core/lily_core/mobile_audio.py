"""Keep mobile audio on the selected Core connection, including remote voice vessels."""

from __future__ import annotations

import asyncio
import hashlib
import re
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import requests

from .audio_access import prune_core_audio_cache, sign_core_audio_url

MAX_AUDIO_BYTES = 32 * 1024 * 1024


def _origin(value: str):
    parsed = urlsplit(value)
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def cache_mobile_audio(value: str | None, directory: Path, trusted_urls: list[str]) -> str | None:
    if not value:
        return None
    parsed = urlsplit(value)
    if not re.fullmatch(r"/static/audio/[A-Za-z0-9_-]+\.(wav|ogg|mp3)", parsed.path):
        return None
    if not parsed.scheme and not parsed.netloc:
        query = parse_qs(parsed.query)
        return value if query.get("expires") and query.get("signature") else sign_core_audio_url(value)
    if (parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.fragment
            or _origin(value) not in {_origin(url) for url in trusted_urls if url}):
        return None
    directory.mkdir(parents=True, exist_ok=True)
    filename = "cached_mobile_" + hashlib.sha256(value.encode()).hexdigest() + Path(parsed.path).suffix
    destination = directory / filename
    if not destination.is_file():
        temporary = None
        try:
            with requests.Session() as session:
                session.trust_env = False
                with session.get(value, timeout=(3, 45), stream=True, allow_redirects=False) as response:
                    if response.status_code != 200:
                        return None
                    size = 0
                    with tempfile.NamedTemporaryFile(dir=directory, prefix=".mobile-", delete=False) as output:
                        temporary = Path(output.name)
                        for block in response.iter_content(64 * 1024):
                            size += len(block)
                            if size > MAX_AUDIO_BYTES:
                                return None
                            output.write(block)
                    if not size:
                        return None
                    temporary.replace(destination)
            prune_core_audio_cache(directory)
        except (requests.RequestException, OSError, ValueError):
            return None
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    return sign_core_audio_url("/static/audio/" + filename)


async def prepare_mobile_audio(value: str | None) -> str | None:
    from tts import STATIC_AUDIO_DIR
    from .settings import settings
    trusted = [node.url for node in settings.voice_nodes] + [settings.stream_voice_service_url]
    return await asyncio.to_thread(cache_mobile_audio, value, STATIC_AUDIO_DIR, trusted)
