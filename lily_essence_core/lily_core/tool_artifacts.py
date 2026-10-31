import hashlib
import mimetypes
import re
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from .settings import settings


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


def _artifact_root() -> Path:
    root = Path(settings.tool_artifact_dir).expanduser()
    if not root.is_absolute():
        root = (Path(__file__).resolve().parent.parent / root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


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


def public_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(artifact.get("id") or ""),
        "name": str(artifact.get("name") or ""),
        "kind": str(artifact.get("kind") or "file"),
        "mime_type": str(artifact.get("mime_type") or "application/octet-stream"),
        "size_bytes": int(artifact.get("size_bytes") or 0),
        "sha256": str(artifact.get("sha256") or ""),
        "download_url": str(artifact.get("download_url") or ""),
    }


def _sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _resolve_tool_vessel_url(download_url: str, tool_agent_url: str) -> str:
    if download_url.startswith(("http://", "https://")):
        return download_url

    base = tool_agent_url
    if "/api/" in base:
        base = base.split("/api/", 1)[0]
    return urljoin(base.rstrip("/") + "/", download_url.lstrip("/"))


def _remote_run_id(download_url: str) -> str:
    path = urlparse(download_url).path
    marker = "/api/tool/artifacts/"
    if marker not in path:
        return ""
    remainder = path.split(marker, 1)[1]
    run_id = remainder.split("/", 1)[0].strip()
    if not run_id or "/" in run_id or "\\" in run_id or run_id.startswith("."):
        return ""
    return run_id


async def _merge_remote_artifact_listing(
    client: httpx.AsyncClient,
    artifacts: list[dict[str, Any]],
    tool_agent_url: str,
    headers: dict[str, str],
) -> list[dict[str, Any]]:
    run_id = next(
        (
            candidate
            for candidate in (_remote_run_id(str(item.get("download_url") or "")) for item in artifacts)
            if candidate
        ),
        "",
    )
    if not run_id:
        return artifacts

    listing_url = _resolve_tool_vessel_url(f"/api/tool/artifacts/{run_id}", tool_agent_url)
    try:
        response = await client.get(listing_url, headers=headers)
        if getattr(response, "status_code", None) != 200 or not hasattr(response, "json"):
            return artifacts
        payload = response.json()
    except Exception:
        return artifacts

    listed = payload.get("artifacts") if isinstance(payload, dict) else None
    if not isinstance(listed, list):
        return artifacts

    merged: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in [*artifacts, *listed]:
        if not isinstance(item, dict):
            continue
        key = (str(item.get("id") or ""), str(item.get("name") or ""))
        if key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return merged


async def store_remote_artifacts(
    *,
    task_id: str,
    artifacts: list[dict[str, Any]],
    tool_agent_url: str,
    headers: dict[str, str],
    timeout: int,
) -> list[dict[str, Any]]:
    stored: list[dict[str, Any]] = []
    if not artifacts:
        return stored

    allowed_extensions = set(settings.tool_artifact_allowed_extensions)
    task_dir = (_artifact_root() / safe_artifact_name(task_id)).resolve()
    task_dir.mkdir(parents=True, exist_ok=True)

    async with httpx.AsyncClient(timeout=max(10, timeout)) as client:
        artifacts = await _merge_remote_artifact_listing(
            client,
            artifacts,
            tool_agent_url,
            headers,
        )
        for artifact in artifacts:
            download_url = str(artifact.get("download_url") or "").strip()
            original_name = safe_artifact_name(str(artifact.get("name") or "artifact"))
            extension = Path(original_name).suffix.lower()
            if not download_url or extension not in allowed_extensions:
                continue

            response = await client.get(_resolve_tool_vessel_url(download_url, tool_agent_url), headers=headers)
            response.raise_for_status()
            content = response.content
            if len(content) > int(settings.tool_artifact_max_bytes):
                continue

            digest = _sha256_bytes(content)
            artifact_key = _sha256_bytes(f"{digest}:{original_name}:{artifact.get('id') or ''}".encode("utf-8"))
            artifact_id = f"art_{artifact_key[:16]}"
            filename = f"{artifact_id}_{original_name}"
            target = (task_dir / filename).resolve()
            target.write_bytes(content)

            mime_type = MIME_BY_EXTENSION.get(extension) or mimetypes.guess_type(original_name)[0] or "application/octet-stream"
            stored.append(
                {
                    "id": artifact_id,
                    "name": original_name,
                    "kind": artifact_kind(extension),
                    "mime_type": mime_type,
                    "size_bytes": len(content),
                    "sha256": digest,
                    "download_url": f"/api/tools/openclaw/{task_id}/artifacts/{artifact_id}",
                    "storage_path": str(target),
                }
            )

    return stored
