import re
from typing import Any
from pathlib import Path

from lily_tool_vessel.artifacts import collect_artifacts, wait_for_artifacts
from lily_tool_vessel.schemas import ToolRunRequest
from lily_tool_vessel.settings import ToolVesselSettings

from .hermes import hermes_health, run_hermes
from .openclaw import openclaw_health, run_openclaw


PROVIDER_RUNNERS = {
    "hermes": run_hermes,
    "openclaw": run_openclaw,
}

WINDOWS_PATH_RE = re.compile(r"(?<![A-Za-z0-9])(?:[A-Za-z]:\\|[A-Za-z]:/)[^\s`\"'<>|]+")
UNIX_PATH_RE = re.compile(r"(?<![:\w])/(?:[^/\s`\"'<>]+/)+[^/\s`\"'<>]+")


def sanitize_result_text(
    result_text: str,
    provider_artifact_dir: Path | None = None,
    artifact_root: Path | None = None,
    artifacts: list[dict[str, Any]] | None = None,
) -> str:
    text = (result_text or "").strip()
    if not text:
        return text

    replacements: dict[str, str] = {}
    if artifacts and provider_artifact_dir:
        for artifact in artifacts:
            artifact_name = str(artifact.get("name") or "").strip()
            if not artifact_name:
                continue
            artifact_path = (provider_artifact_dir / artifact_name).resolve()
            replacements[str(artifact_path)] = artifact_name
            replacements[str(artifact_path).replace("\\", "/")] = artifact_name

    if provider_artifact_dir:
        replacements[str(provider_artifact_dir.resolve())] = "[artifact folder hidden]"
        replacements[str(provider_artifact_dir.resolve()).replace("\\", "/")] = "[artifact folder hidden]"
    if artifact_root:
        replacements[str(artifact_root.resolve())] = "[artifact folder hidden]"
        replacements[str(artifact_root.resolve()).replace("\\", "/")] = "[artifact folder hidden]"

    for source, target in sorted(replacements.items(), key=lambda item: len(item[0]), reverse=True):
        text = text.replace(source, target)

    artifact_names = sorted(
        {
            str(artifact.get("name") or "").strip()
            for artifact in artifacts or []
            if str(artifact.get("name") or "").strip()
        },
        key=len,
        reverse=True,
    )
    for artifact_name in artifact_names:
        relative_pattern = re.compile(
            rf"(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9_. -]+[\\/])+{re.escape(artifact_name)}"
        )
        text = relative_pattern.sub(artifact_name, text)

    text = re.sub(r"\*{1,2}([^*\n]+)\*{1,2}", r"\1", text)
    text = re.sub(r"`([^`\n]+)`", r"\1", text)
    text = re.sub(r"\brelay this to the owner\b:?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\brelay to owner\b:?", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bready for whatsapp relay\b[:.]?", "ready.", text, flags=re.IGNORECASE)
    text = re.sub(r"\bready for delivery to owner\b[:.]?", "ready.", text, flags=re.IGNORECASE)
    text = re.sub(r"\bapproval test passed\b[:.]?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bwrite approval verified\b[:.]?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\bready for your next command\b(?:,\s*(?:owner~?|sayang|dear|sweetheart|honey))?[.!~]*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"(?:,\s*)?owner~\b", "", text, flags=re.IGNORECASE)
    text = re.sub(r"(?:,\s*)?(?:sayang|dear|sweetheart|honey)\b(?=[.!~]*$)", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+[—-]\s+ready\.", ".", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    def _replace_match(match: re.Match[str]) -> str:
        raw = match.group(0)
        normalized = raw.replace("\\", "/")
        if raw.startswith("//") or normalized.startswith(("/api/", "/static/")):
            return raw
        leaf = Path(normalized.rstrip("/")).name.strip()
        return leaf if "." in leaf else "[local path hidden]"

    text = WINDOWS_PATH_RE.sub(_replace_match, text)
    text = UNIX_PATH_RE.sub(_replace_match, text)
    return text


def resolve_provider_chain(payload: ToolRunRequest, settings: ToolVesselSettings) -> list[str]:
    requested = (payload.provider or settings.provider or "hermes").strip().lower()
    candidates = [requested]
    if settings.fallback_enabled:
        candidates.extend(settings.fallback_chain)

    chain: list[str] = []
    for candidate in candidates:
        normalized = (candidate or "").strip().lower()
        if normalized and normalized not in chain:
            chain.append(normalized)
    return chain


async def run_provider(payload: ToolRunRequest, settings: ToolVesselSettings) -> str:
    result = await run_provider_with_fallback(payload, settings)
    if not result["ok"]:
        raise RuntimeError(result["error"])
    return result["result_text"]


async def run_provider_with_fallback(payload: ToolRunRequest, settings: ToolVesselSettings) -> dict[str, Any]:
    chain = resolve_provider_chain(payload, settings)
    requested_provider = chain[0] if chain else (payload.provider or settings.provider or "hermes").strip().lower()
    attempts: list[dict[str, str]] = []
    artifact_root = Path(payload.artifact_dir).resolve() if payload.artifact_dir else None
    run_id = artifact_root.name if artifact_root else ""
    prepared_input_files = payload.input_files if isinstance(payload.input_files, list) else []
    prepared_input_dir = ""

    if artifact_root and prepared_input_files:
        import base64
        import hashlib

        allowed_extensions = set(getattr(settings, "input_allowed_extensions", [".pdf"]))
        max_input_bytes = int(getattr(settings, "input_max_bytes", 20 * 1024 * 1024))
        input_root = (artifact_root / "inputs").resolve()
        input_root.mkdir(parents=True, exist_ok=True)
        normalized_inputs: list[dict[str, Any]] = []

        for index, item in enumerate(prepared_input_files, start=1):
            if not isinstance(item, dict):
                continue

            raw_name = Path(str(item.get("name") or f"input_{index}.pdf")).name.strip()
            safe_name = re.sub(r"[^A-Za-z0-9._ -]+", "_", raw_name).strip(" ._-") or f"input_{index}.pdf"
            if safe_name.startswith("."):
                safe_name = safe_name.lstrip(".") or f"input_{index}.pdf"

            extension = Path(safe_name).suffix.lower()
            mime_type = str(item.get("mime_type") or "").strip().lower()
            if extension not in allowed_extensions:
                continue
            if mime_type and mime_type != "application/pdf" and extension == ".pdf":
                continue

            raw_content = str(item.get("content_base64") or "").strip()
            if not raw_content:
                continue

            try:
                content = base64.b64decode(raw_content, validate=True)
            except Exception:
                continue

            if len(content) > max_input_bytes:
                continue

            target = (input_root / safe_name).resolve()
            suffix_counter = 2
            while target.exists():
                target = (input_root / f"{Path(safe_name).stem}_{suffix_counter}{extension}").resolve()
                suffix_counter += 1
            target.write_bytes(content)

            digest = hashlib.sha256(content).hexdigest()
            normalized_inputs.append(
                {
                    "id": str(item.get("id") or f"input_{digest[:12]}"),
                    "name": target.name,
                    "kind": "document",
                    "mime_type": "application/pdf",
                    "size_bytes": len(content),
                    "sha256": str(item.get("sha256") or digest),
                    "local_path": str(target),
                }
            )

        prepared_input_files = normalized_inputs
        if normalized_inputs:
            prepared_input_dir = str(input_root)

    for provider in chain:
        runner = PROVIDER_RUNNERS.get(provider)
        if not runner:
            attempts.append({
                "provider": provider,
                "status": "unsupported",
                "error": f"Unsupported tool provider: {provider}",
            })
            continue

        try:
            provider_payload = payload
            provider_artifact_dir: Path | None = None
            if artifact_root:
                provider_artifact_dir = artifact_root / provider
                provider_artifact_dir.mkdir(parents=True, exist_ok=True)
                provider_payload = payload.model_copy(
                    update={
                        "artifact_dir": str(provider_artifact_dir),
                        "input_dir": prepared_input_dir,
                        "input_files": prepared_input_files,
                    }
                )

            raw_result_text = await runner(provider_payload, settings)
            if provider_artifact_dir:
                await wait_for_artifacts(provider_artifact_dir, settings)
            artifacts = collect_artifacts(provider_artifact_dir, settings, run_id) if provider_artifact_dir else []
            result_text = sanitize_result_text(raw_result_text, provider_artifact_dir, artifact_root, artifacts)
            attempts.append({
                "provider": provider,
                "status": "completed",
                "error": "",
            })
            return {
                "ok": True,
                "provider": provider,
                "requested_provider": requested_provider,
                "fallback_used": provider != requested_provider,
                "provider_attempts": attempts,
                "result_text": result_text,
                "error": "",
                "artifacts": artifacts,
            }
        except Exception as error:
            attempts.append({
                "provider": provider,
                "status": "failed",
                "error": str(error),
            })

    error_summary = "; ".join(
        f"{item['provider']}: {item['status']}" + (f" ({item['error']})" if item.get("error") else "")
        for item in attempts
    ) or "No tool providers were attempted."
    return {
        "ok": False,
        "provider": requested_provider,
        "requested_provider": requested_provider,
        "fallback_used": any(item["provider"] != requested_provider for item in attempts),
        "provider_attempts": attempts,
        "result_text": "",
        "error": error_summary,
        "artifacts": [],
    }


def get_provider_health(settings: ToolVesselSettings) -> dict[str, Any]:
    providers = {
        "hermes": hermes_health(settings),
        "openclaw": openclaw_health(settings),
    }
    selected = providers.get(settings.provider, {"provider": settings.provider, "cli_available": False})
    workdir_ready = bool(settings.workdir) and __import__("os").path.isdir(settings.workdir)

    if selected.get("cli_available") and workdir_ready:
        status = "online"
        detail = f"{settings.provider} is available through Lily Tool Vessel."
    elif selected.get("cli_available"):
        status = "degraded"
        detail = "Tool provider CLI is available, but LILY_TOOL_WORKDIR does not exist."
    else:
        status = "offline"
        detail = f"Tool provider CLI is not available: {settings.provider}."

    return {
        "status": status,
        "detail": detail,
        "provider": settings.provider,
        "fallback_enabled": settings.fallback_enabled,
        "fallback_chain": settings.fallback_chain,
        "workdir": settings.workdir,
        "workdir_ready": workdir_ready,
        "providers": providers,
    }
