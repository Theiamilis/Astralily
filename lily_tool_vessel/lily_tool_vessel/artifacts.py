import asyncio
import hashlib
import mimetypes
import re
import time
from pathlib import Path
from typing import Any


MIME_BY_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".zip": "application/zip",
}


def safe_artifact_name(value: str) -> str:
    name = Path(value or "artifact").name.strip()
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name)
    name = name.strip(" ._-") or "artifact"
    if name.startswith("."):
        name = name.lstrip(".") or "artifact"
    return name[:140]


def artifact_kind(extension: str) -> str:
    if extension in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return "image"
    if extension in {".pdf", ".docx"}:
        return "document"
    if extension == ".xlsx":
        return "spreadsheet"
    if extension in {".txt", ".md"}:
        return "text"
    if extension == ".zip":
        return "archive"
    return "file"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _has_hidden_part(path: Path) -> bool:
    return any(part.startswith(".") for part in path.parts)


def _artifact_snapshot(root: Path, settings: Any) -> tuple[tuple[str, int, int], ...]:
    allowed_extensions = set(settings.artifact_allowed_extensions)
    snapshot: list[tuple[str, int, int]] = []
    for candidate in sorted(root.rglob("*")):
        if not candidate.is_file():
            continue
        try:
            relative = candidate.resolve().relative_to(root)
            stat = candidate.stat()
        except (OSError, ValueError):
            continue
        if _has_hidden_part(relative) or candidate.suffix.lower() not in allowed_extensions:
            continue
        snapshot.append((relative.as_posix(), stat.st_size, stat.st_mtime_ns))
    return tuple(snapshot)


async def wait_for_artifacts(artifact_dir: str | Path, settings: Any) -> None:
    """Allow agents a short grace period to finish writes after CLI exit."""
    root = Path(artifact_dir or "").resolve()
    if not root.is_dir():
        return

    started = time.monotonic()
    deadline = started + 2.5
    empty_deadline = started + 0.75
    previous: tuple[tuple[str, int, int], ...] | None = None
    stable_reads = 0

    while time.monotonic() < deadline:
        current = _artifact_snapshot(root, settings)
        if current:
            if current == previous:
                stable_reads += 1
                if stable_reads >= 1:
                    return
            else:
                stable_reads = 0
        elif time.monotonic() >= empty_deadline:
            return
        previous = current
        await asyncio.sleep(0.2)


def collect_artifacts(artifact_dir: str | Path, settings: Any, run_id: str, include_path: bool = False) -> list[dict[str, Any]]:
    root = Path(artifact_dir or "").resolve()
    if not root.is_dir():
        return []

    allowed_extensions = set(settings.artifact_allowed_extensions)
    max_bytes = int(settings.artifact_max_bytes)
    collected: list[dict[str, Any]] = []

    for candidate in sorted(root.rglob("*")):
        if not candidate.is_file():
            continue

        resolved = candidate.resolve()
        try:
            relative = resolved.relative_to(root)
        except ValueError:
            continue

        if _has_hidden_part(relative):
            continue

        extension = resolved.suffix.lower()
        if extension not in allowed_extensions:
            continue

        size_bytes = resolved.stat().st_size
        if size_bytes > max_bytes:
            continue

        digest = sha256_file(resolved)
        mime_type = MIME_BY_EXTENSION.get(extension) or mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        artifact_key = hashlib.sha256(f"{digest}:{relative.as_posix()}".encode("utf-8")).hexdigest()
        artifact_id = f"art_{artifact_key[:16]}"

        artifact = {
            "id": artifact_id,
            "name": safe_artifact_name(resolved.name),
            "kind": artifact_kind(extension),
            "mime_type": mime_type,
            "size_bytes": size_bytes,
            "sha256": digest,
            "download_url": f"/api/tool/artifacts/{run_id}/{artifact_id}",
        }
        if include_path:
            artifact["storage_path"] = str(resolved)
        collected.append(artifact)

    return collected
