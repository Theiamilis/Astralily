"""Server-side audio stitching for the legacy single-audio API contract."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import uuid
import wave
from pathlib import Path
from urllib.parse import urlparse

import requests

from tts import STATIC_AUDIO_DIR
from .audio_access import prune_core_audio_cache


logger = logging.getLogger("uvicorn")
_MAX_AUDIO_BYTES = 32 * 1024 * 1024


def _local_audio_path(audio_url: str) -> Path | None:
    parsed = urlparse(audio_url)
    if parsed.scheme or parsed.netloc:
        return None
    path = parsed.path or audio_url
    if not path.startswith("/static/audio/"):
        return None
    filename = Path(path).name
    if not filename or filename != Path(path).name:
        return None
    candidate = (STATIC_AUDIO_DIR / filename).resolve()
    try:
        candidate.relative_to(STATIC_AUDIO_DIR.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def _download_audio(audio_url: str, destination: Path) -> bool:
    local_path = _local_audio_path(audio_url)
    if local_path:
        shutil.copyfile(local_path, destination)
        return True

    parsed = urlparse(audio_url)
    if parsed.scheme not in {"http", "https"}:
        logger.warning("Cannot stitch unsupported audio URL: %s", audio_url)
        return False

    try:
        response = requests.get(audio_url, timeout=45, stream=True)
        response.raise_for_status()
        written = 0
        with destination.open("wb") as handle:
            for block in response.iter_content(chunk_size=64 * 1024):
                if not block:
                    continue
                written += len(block)
                if written > _MAX_AUDIO_BYTES:
                    logger.warning("Audio segment exceeded the stitching size limit: %s", audio_url)
                    return False
                handle.write(block)
        return written > 0
    except Exception as error:
        logger.warning("Could not download audio segment for stitching: %s", error)
        return False


def _normalize_with_ffmpeg(source: Path, destination: Path, ffmpeg_path: str) -> bool:
    command = [
        ffmpeg_path,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "24000",
        "-c:a",
        "pcm_s16le",
        str(destination),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.SubprocessError) as error:
        logger.warning("FFmpeg could not normalize TTS audio: %s", error)
        return False
    if result.returncode != 0:
        logger.warning("FFmpeg normalization failed: %s", result.stderr.strip()[-500:])
        return False
    return destination.is_file() and destination.stat().st_size > 44


def stitch_audio_urls(audio_urls: list[str], gap_ms: int = 80) -> str | None:
    """Download/normalize/concatenate TTS segments into one static WAV file."""
    urls = [str(value or "").strip() for value in audio_urls if str(value or "").strip()]
    if not urls:
        return None
    if len(urls) == 1:
        return urls[0]

    ffmpeg_path = os.getenv("LILY_TTS_FFMPEG_PATH", "ffmpeg").strip() or "ffmpeg"
    gap_frames = max(0, int(gap_ms)) * 24
    with tempfile.TemporaryDirectory(prefix="lily-tts-stitch-") as temp_dir:
        temp_root = Path(temp_dir)
        normalized_paths: list[Path] = []
        for index, audio_url in enumerate(urls):
            source = temp_root / f"source_{index}.audio"
            normalized = temp_root / f"normalized_{index}.wav"
            if not _download_audio(audio_url, source):
                return None
            if not _normalize_with_ffmpeg(source, normalized, ffmpeg_path):
                return None
            normalized_paths.append(normalized)

        output_name = f"cached_chunked_{uuid.uuid4().hex}.wav"
        output_path = STATIC_AUDIO_DIR / output_name
        STATIC_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        try:
            with wave.open(str(output_path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(24000)
                silence = b"\x00\x00" * gap_frames
                for index, normalized in enumerate(normalized_paths):
                    with wave.open(str(normalized), "rb") as segment:
                        output.writeframes(segment.readframes(segment.getnframes()))
                    if index < len(normalized_paths) - 1 and gap_frames:
                        output.writeframes(silence)
        except (OSError, wave.Error) as error:
            output_path.unlink(missing_ok=True)
            logger.warning("Could not stitch normalized TTS audio: %s", error)
            return None

    prune_core_audio_cache(STATIC_AUDIO_DIR)
    return f"/static/audio/{output_name}"
