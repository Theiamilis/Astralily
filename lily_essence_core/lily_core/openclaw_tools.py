import asyncio
import base64
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import time
import urllib.request
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from .settings import settings
from .tool_artifacts import public_artifact, store_remote_artifacts


SAFE_ACTIONS = {"web_search", "browse", "research", "summarize", "status"}
WRITE_ACTIONS = {"file_task", "automation", "system", "command", "send_message", "delete", "dangerous"}
BLOCKED_SOURCES = {"stream_stage", "tiktok_bridge"}
MAX_RESULT_CHARS = 6000
WINDOWS_PATH_RE = re.compile(r"(?<![A-Za-z0-9])(?:[A-Za-z]:\\|[A-Za-z]:/)[^\s`\"'<>|]+")
UNIX_PATH_RE = re.compile(r"(?<![:\w])/(?:[^/\s`\"'<>]+/)+[^/\s`\"'<>]+")
DIRECT_FILE_COMMAND_RE = re.compile(
    r"^\s*(?:(?:hey\s+)?lily\s*[,!:\-]?\s+)?"
    r"(?:(?:(?:tolong|mohon|please|pls|coba|cobain|bebas)\s+){0,3}|(?:can|could|would)\s+you\s+)?"
    r"(?:bikinin|buatkan|bikin|buat|jadiin|jadikan|ubah|konversi|convert|export|simpan|save|"
    r"create|make|turn|edit|rapiin|benerin|merge|gabungin|gabung|split|pisahkan|pisah|"
    r"hapus|buang|remove|tambahin|tambah|kasih)\b",
    flags=re.IGNORECASE,
)
FILE_ARTIFACT_RE = re.compile(
    r"\b(?:file|dokumen|document|word|docx|pdf|excel|xlsx|powerpoint|pptx|"
    r"spreadsheet|presentation|halaman|page)\b",
    flags=re.IGNORECASE,
)
FILE_DISCUSSION_RE = re.compile(
    r"(?:\b(?:gimana|bagaimana|caranya|pakai\s+apa|pake\s+apa)\b\s*[?.!]*$|"
    r"\b(?:susah|gampang|mudah|ribet)\s+(?:ga|gak|nggak|enggak|kah)\b\s*[?.!]*$|"
    r"\b(?:itu|emang|memang)\s+(?:susah|gampang|mudah|ribet)\b)",
    flags=re.IGNORECASE,
)


def _looks_like_direct_file_task(message: str) -> bool:
    """Detect imperative file work without treating ordinary file talk as a task."""
    text = re.sub(r"\s+", " ", (message or "").strip())
    if not text:
        return False
    command = DIRECT_FILE_COMMAND_RE.match(text)
    if command is None:
        return False
    if FILE_DISCUSSION_RE.search(text):
        return False
    return FILE_ARTIFACT_RE.search(text, command.end()) is not None


@dataclass
class OpenClawTask:
    id: str
    action: str
    task: str
    source: str
    requester: str
    session_id: str
    status: str
    risk: str
    requires_approval: bool
    created_at: float
    updated_at: float
    approved_at: float | None = None
    completed_at: float | None = None
    delivered_at: float | None = None
    result_text: str = ""
    error: str = ""
    input_files: list[dict[str, Any]] = field(default_factory=list)
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    tool_provider: str = ""
    requested_provider: str = ""
    fallback_used: bool = False
    provider_attempts: list[dict[str, Any]] = field(default_factory=list)
    delivery_channel: str = "control_center"
    delivery_target: str = ""
    delivery_profile: str = "personal"
    delivery_status: str = "pending"
    delivery_claimed_at: float | None = None
    delivery_claimed_by: str = ""
    delivery_error: str = ""
    delivery_attempt_count: int = 0
    delivery_latency_ms: int | None = None
    approval_expires_at: float | None = None
    approval_idempotency_key: str = ""
    mutation_idempotency_key: str = ""
    progress_percent: int = 0
    progress_message: str = ""
    estimated_duration_seconds: int = 0
    execution_started_at: float | None = None
    execution_completed_at: float | None = None
    execution_latency_ms: int | None = None
    retry_count: int = 0
    recovery_required: bool = False

    def to_public_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["input_files"] = [_public_input_file(item) for item in self.input_files]
        payload["artifacts"] = [public_artifact(artifact) for artifact in self.artifacts]
        payload["provider_attempts"] = _public_provider_attempts(self.provider_attempts)
        payload["created_at_iso"] = _format_timestamp(self.created_at)
        payload["updated_at_iso"] = _format_timestamp(self.updated_at)
        if self.approved_at:
            payload["approved_at_iso"] = _format_timestamp(self.approved_at)
        if self.completed_at:
            payload["completed_at_iso"] = _format_timestamp(self.completed_at)
        if self.delivered_at:
            payload["delivered_at_iso"] = _format_timestamp(self.delivered_at)
        if self.approval_expires_at:
            payload["approval_expires_at_iso"] = _format_timestamp(self.approval_expires_at)
        if self.execution_started_at:
            payload["execution_started_at_iso"] = _format_timestamp(self.execution_started_at)
        if self.execution_completed_at:
            payload["execution_completed_at_iso"] = _format_timestamp(self.execution_completed_at)
        execution_end = self.execution_completed_at or (_now() if self.execution_started_at else None)
        payload["elapsed_seconds"] = (
            max(0, int(execution_end - self.execution_started_at))
            if execution_end and self.execution_started_at
            else 0
        )
        return payload


_tasks: dict[str, OpenClawTask] = {}
_lock = asyncio.Lock()
_execution_tasks: dict[str, asyncio.Task[Any]] = {}
_last_artifact_prune_at: float | None = None


def _format_timestamp(value: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value))


def _public_input_file(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(item.get("id") or ""),
        "name": str(item.get("name") or ""),
        "kind": str(item.get("kind") or "document"),
        "mime_type": str(item.get("mime_type") or "application/octet-stream"),
        "size_bytes": int(item.get("size_bytes") or 0),
        "sha256": str(item.get("sha256") or ""),
    }


def _now() -> float:
    return time.time()


def _trim_result(value: str, limit: int = MAX_RESULT_CHARS) -> str:
    text = (value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}\n...[trimmed]"


def _friendly_failure(value: str) -> str:
    text = _sanitize_tool_result_text(value)
    lower = text.lower()
    if "timed out" in lower or "timeout" in lower:
        return "The tool task timed out. You can retry execution."
    if "not available" in lower or "not reachable" in lower or "connection" in lower:
        return "The tool provider is unavailable. You can retry execution."
    if "disabled" in lower or "blocked" in lower:
        return "This tool task was blocked by Lily's safety policy."
    return "The tool task failed. You can retry execution."


def _public_provider_attempts(attempts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    public: list[dict[str, Any]] = []
    for attempt in attempts:
        if not isinstance(attempt, dict):
            continue
        status = str(attempt.get("status") or "unknown").strip().lower()
        error = str(attempt.get("error") or "").strip()
        public.append(
            {
                "provider": str(attempt.get("provider") or "unknown").strip()[:80],
                "status": status[:40],
                "latency_ms": int(attempt.get("latency_ms") or 0),
                "error": _friendly_failure(error) if error else "",
            }
        )
    return public


def _artifact_root() -> Path:
    configured = Path(settings.tool_artifact_dir).expanduser()
    if not configured.is_absolute():
        configured = (Path(__file__).resolve().parent.parent / configured).resolve()
    configured.mkdir(parents=True, exist_ok=True)
    return configured


def _tool_input_root() -> Path:
    configured = Path(settings.tool_artifact_dir).expanduser()
    if not configured.is_absolute():
        configured = (Path(__file__).resolve().parent.parent / configured).resolve()
    root = (configured.parent / "tool_inputs").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_input_name(value: str, fallback: str = "input.pdf") -> str:
    name = Path(value or fallback).name.strip()
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name)
    name = name.strip(" ._-") or fallback
    if name.startswith("."):
        name = name.lstrip(".") or fallback
    return name[:140]


def _store_input_files(task_id: str, input_files: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not input_files:
        return []

    allowed_extensions = {".pdf"}
    max_bytes = int(settings.tool_artifact_max_bytes)
    task_dir = (_tool_input_root() / _safe_input_name(task_id, "tool_input")).resolve()
    task_dir.mkdir(parents=True, exist_ok=True)
    stored: list[dict[str, Any]] = []

    for index, item in enumerate(input_files, start=1):
        if not isinstance(item, dict):
            continue

        original_name = _safe_input_name(str(item.get("name") or f"input_{index}.pdf"))
        extension = Path(original_name).suffix.lower()
        mime_type = str(item.get("mime_type") or "").strip().lower()
        if extension not in allowed_extensions:
            continue
        if mime_type and mime_type != "application/pdf":
            continue

        raw_content = str(item.get("content_base64") or "").strip()
        if not raw_content:
            continue

        try:
            content = base64.b64decode(raw_content, validate=True)
        except Exception:
            continue

        if len(content) > max_bytes:
            continue

        digest = hashlib.sha256(content).hexdigest()
        filename = original_name
        target = (task_dir / filename).resolve()
        suffix_counter = 2
        while target.exists():
            filename = f"{Path(original_name).stem}_{suffix_counter}{extension}"
            target = (task_dir / filename).resolve()
            suffix_counter += 1

        target.write_bytes(content)
        stored.append(
            {
                "id": str(item.get("id") or f"input_{digest[:12]}"),
                "name": filename,
                "kind": "document",
                "mime_type": "application/pdf",
                "size_bytes": len(content),
                "sha256": str(item.get("sha256") or digest),
                "content_base64": raw_content,
                "local_path": str(target),
            }
        )

    return stored


def _sanitize_tool_result_text(value: str, artifacts: list[dict[str, Any]] | None = None) -> str:
    text = _trim_result(value)
    if not text:
        return text

    replacements: dict[str, str] = {}
    for artifact in artifacts or []:
        storage_path = str(artifact.get("storage_path") or "").strip()
        artifact_name = str(artifact.get("name") or "").strip()
        if not storage_path or not artifact_name:
            continue
        replacements[storage_path] = artifact_name
        replacements[storage_path.replace("\\", "/")] = artifact_name

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


def _split_words(value: str) -> set[str]:
    return {item.strip().lower() for item in (value or "").replace("_", " ").split() if item.strip()}


def normalize_openclaw_action(action: str | None, task: str = "") -> str:
    raw = (action or "").strip().lower().replace("-", "_").replace(" ", "_")
    if raw:
        aliases = {
            "search": "web_search",
            "lookup": "web_search",
            "look_up": "web_search",
            "google": "web_search",
            "open": "browse",
            "website": "browse",
            "read": "browse",
            "summary": "summarize",
            "summarise": "summarize",
            "file": "file_task",
            "files": "file_task",
            "edit": "file_task",
            "code": "file_task",
            "run": "command",
            "exec": "command",
            "execute": "command",
        }
        return aliases.get(raw, raw)

    lower = task.lower()
    if any(marker in lower for marker in ("http://", "https://", "website", "browser", "browse", "buka web", "check the web")):
        return "browse"
    if any(marker in lower for marker in ("cari", "cariin", "search", "search this", "google", "berita", "latest", "lookup", "cek info", "cek web", "lihatin")):
        return "web_search"
    if any(marker in lower for marker in ("rangkum", "summarize", "summary", "ringkas")):
        return "summarize"
    if _looks_like_direct_file_task(task) or any(marker in lower for marker in (
        "edit",
        "edit pdf",
        "pdf ini",
        "hapus halaman",
        "remove page",
        "merge pdf",
        "split pdf",
        "watermark",
        "annotate",
        "ubah file",
        "benerin file",
        "rename",
        "hapus file",
        "delete",
        "buat file",
        "bikinin file",
        "create a file",
        "create file",
        "make a file",
        "make file",
        "edit a file",
        "jadiin pdf",
        "bikin pdf",
        "make a pdf",
        "make pdf",
        "export pdf",
    )):
        return "file_task"
    if any(marker in lower for marker in ("jalanin", "run command", "command", "terminal", "powershell")):
        return "command"
    return "research"


def classify_openclaw_risk(action: str, task: str = "") -> str:
    action = normalize_openclaw_action(action, task)
    lower = task.lower()
    if action in WRITE_ACTIONS or any(word in lower for word in ("delete", "hapus", "format", "shutdown", "send message", "kirim pesan")):
        return "write"
    if action in SAFE_ACTIONS:
        return "read"
    return "write"


def is_openclaw_source_allowed(source: str) -> bool:
    normalized = (source or "").strip().lower()
    if normalized in BLOCKED_SOURCES:
        return False
    return normalized in set(settings.openclaw_allowed_sources)


def build_openclaw_intent(message: str) -> dict[str, Any] | None:
    text = (message or "").strip()
    lower = text.lower()
    if not text:
        return None

    direct_prefixes = (
        "openclaw",
        "lily openclaw",
        "lily, openclaw",
        "lily pakai openclaw",
        "lily pake openclaw",
        "pakai openclaw",
        "pake openclaw",
    )
    trigger_words = (
        "search",
        "browse",
        "cari di web",
        "cek web",
        "lihat website",
        "buka website",
        "berita terbaru",
        "latest news",
        "search this",
        "check the web",
        "cariin",
    )
    casual_task_patterns = (
        r"\bsearch\s+this\b",
        r"\bcheck\s+the\s+web\b",
        r"\blihatin\b.*\b(?:web|website|link|artikel|info)\b",
    )

    has_direct_prefix = any(lower.startswith(prefix) for prefix in direct_prefixes)
    has_trigger = any(trigger in lower for trigger in trigger_words)
    has_casual_task_pattern = _looks_like_direct_file_task(text) or any(
        re.search(pattern, lower) for pattern in casual_task_patterns
    )
    if not has_direct_prefix and not has_trigger and not has_casual_task_pattern:
        return None

    task = text
    for prefix in direct_prefixes:
        if lower.startswith(prefix):
            task = text[len(prefix):].lstrip(" ,:-")
            break

    task = task or text
    direct_file_task = _looks_like_direct_file_task(text)
    confidence = 1.0 if has_direct_prefix else (0.92 if direct_file_task else 0.72)
    return {
        "tool": "openclaw",
        "action": normalize_openclaw_action(None, task),
        "task": task,
        "confidence": confidence,
        "confidence_reason": "explicit_tool_prefix" if has_direct_prefix else (
            "direct_file_instruction" if direct_file_task else "keyword_match"
        ),
    }


def openclaw_tool_instruction() -> str:
    actions = ", ".join(settings.openclaw_allowed_actions)
    return (
        "If the owner asks for external browsing, research, file/task automation, or agent work, "
        "never claim the work is done, queued, sent, or currently being performed in a normal chat reply. "
        "Lily Core handles real tool requests before this prompt; if one still reaches normal chat, say that "
        "the task was not queued and ask the owner to restate the action and output format explicitly. "
        f"Allowed OpenClaw actions: {actions}. Stream Stage and TikTok live events must never request OpenClaw."
    )


def _resolve_cli() -> tuple[str | None, str]:
    configured = settings.openclaw_cli
    if os.path.isabs(configured) and os.path.exists(configured):
        return configured, configured
    resolved = shutil.which(configured)
    return resolved, configured


def _gateway_reachable() -> bool:
    gateway_url = settings.openclaw_gateway_url.strip()
    if not gateway_url:
        return False

    parsed = urlparse(gateway_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 18789
    try:
        with socket.create_connection((host, port), timeout=0.35):
            return True
    except OSError:
        return False


def _task_to_prompt(task: OpenClawTask) -> str:
    input_instruction = ""
    if task.input_files:
        input_lines: list[str] = []
        has_pdf = False
        for item in task.input_files:
            name = str(item.get("name") or "input").strip() or "input"
            mime_type = str(item.get("mime_type") or "application/octet-stream").strip() or "application/octet-stream"
            local_path = str(item.get("local_path") or "").strip()
            sha256 = str(item.get("sha256") or "").strip()
            if mime_type == "application/pdf" or name.lower().endswith(".pdf"):
                has_pdf = True
            digest_note = f", sha256 {sha256[:12]}" if sha256 else ""
            path_note = f", path {local_path}" if local_path else ""
            input_lines.append(f"- {name} ({mime_type}{digest_note}{path_note})")
        input_instruction = (
            "\nInput files are available for this task.\n"
            "Use them as source material when the task refers to an uploaded document or PDF.\n"
            "Never overwrite the input file in place. Save final outputs separately.\n"
            "Input files:\n"
            + "\n".join(input_lines)
        )
        if has_pdf:
            input_instruction += (
                "\nIf the owner asks to edit, split, merge, reorder, summarize, cover, watermark, annotate, "
                "or convert a PDF, read the PDF input and write the final result as a new PDF file."
            )
    file_task_instruction = ""
    if task.action == "file_task":
        file_task_instruction = (
            "\nFor file tasks, prefer plain phrasing like: "
            "'Created <filename> with the requested content.' "
            "Keep it natural and direct. Do not mention relaying, tests, verification, or next commands. "
            "Avoid approval-test language, pet names, tildes, or lines like 'ready for your next command'."
        )
    return (
        "You are OpenClaw executing a Lily AI owner-approved tool task.\n"
        f"Source: {task.source}\n"
        f"Requester: {task.requester}\n"
        f"Action: {task.action}\n"
        f"Risk: {task.risk}\n\n"
        "Return a concise, owner-facing result that can be sent directly in Lily chat. "
        "Do not message other people or modify files unless the task explicitly asks and approval was granted."
        f"{input_instruction}{file_task_instruction}\n\n"
        f"Task:\n{task.task}"
    )


def _resolve_delivery_channel(source: str, delivery_channel: str | None, delivery_target: str | None) -> str:
    # Mobile Realm is an owner control surface, not an artifact inbox. Keep the
    # recipient opaque to Android and let the personal WA Vessel resolve it.
    if source == "mobile_realm":
        return "wa"
    requested = (delivery_channel or "").strip().lower()
    if requested:
        return requested
    if source == "wa_bridge" and (delivery_target or "").strip():
        return "wa"
    return "control_center"


def _resolve_delivery_target(source: str, delivery_channel: str, delivery_target: str | None) -> str:
    if source == "mobile_realm" and delivery_channel == "wa":
        return "owner"
    return (delivery_target or "").strip()


async def _run_openclaw_cli(task: OpenClawTask) -> dict[str, Any]:
    cli_path, cli_label = _resolve_cli()
    if not cli_path:
        raise RuntimeError(f"OpenClaw CLI is not available on PATH as '{cli_label}'.")

    prompt = _task_to_prompt(task)
    timeout = max(10, int(settings.openclaw_timeout_seconds))
    cwd = str(os.getenv("LILY_OPENCLAW_WORKDIR", "").strip() or PathLikeDefault.cwd())

    if os.name == "nt":
        command = subprocess.list2cmdline([cli_path, "agent", "--message", prompt])
        proc = await asyncio.create_subprocess_exec(
            "cmd.exe",
            "/c",
            command,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    else:
        proc = await asyncio.create_subprocess_exec(
            cli_path,
            "agent",
            "--message",
            prompt,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.CancelledError:
        proc.kill()
        await proc.communicate()
        raise
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.communicate()
        raise RuntimeError(f"OpenClaw timed out after {timeout}s.") from exc

    out = stdout.decode("utf-8", errors="replace").strip()
    err = stderr.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0:
        detail = err or out or f"OpenClaw exited with code {proc.returncode}."
        raise RuntimeError(_trim_result(detail, 1800))

    return {
        "result_text": _trim_result(out or err or "OpenClaw completed without text output."),
        "artifacts": [],
        "tool_provider": "openclaw",
        "requested_provider": "openclaw",
        "fallback_used": False,
        "provider_attempts": [{"provider": "openclaw", "status": "completed", "error": ""}],
    }


async def _run_remote_tool_agent(task: OpenClawTask) -> dict[str, Any]:
    if not settings.tool_agent_url:
        raise RuntimeError("LILY_TOOL_AGENT_URL is empty while remote tool mode is enabled.")

    timeout = max(10, int(settings.tool_agent_timeout_seconds))
    headers = {"Content-Type": "application/json"}
    if settings.tool_agent_token:
        headers["X-Lily-Token"] = settings.tool_agent_token

    payload = {
        "task": task.task,
        "action": task.action,
        "source": task.source,
        "requester": task.requester,
        "session_id": task.session_id,
        "risk": task.risk,
        "provider": settings.tool_agent_provider,
        "timeout_seconds": timeout,
        "input_files": task.input_files,
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(settings.tool_agent_url, json=payload, headers=headers)

    if response.status_code >= 400:
        raise RuntimeError(_trim_result(response.text, 1800))

    data = response.json()
    if not data.get("ok"):
        detail = data.get("error") or data.get("detail") or "Remote tool vessel reported failure."
        raise RuntimeError(_trim_result(str(detail), 1800))

    artifacts = await store_remote_artifacts(
        task_id=task.id,
        artifacts=data.get("artifacts") if isinstance(data.get("artifacts"), list) else [],
        tool_agent_url=settings.tool_agent_url,
        headers=headers,
        timeout=timeout,
    )
    return {
        "result_text": _trim_result(data.get("result_text") or "Remote tool vessel completed without text output."),
        "artifacts": artifacts,
        "tool_provider": str(data.get("provider") or settings.tool_agent_provider or ""),
        "requested_provider": str(data.get("requested_provider") or settings.tool_agent_provider or ""),
        "fallback_used": bool(data.get("fallback_used")),
        "provider_attempts": data.get("provider_attempts") if isinstance(data.get("provider_attempts"), list) else [],
    }


async def _run_tool_agent(task: OpenClawTask) -> dict[str, Any]:
    if settings.tool_agent_mode == "remote":
        return await _run_remote_tool_agent(task)
    return await _run_openclaw_cli(task)


class PathLikeDefault:
    @staticmethod
    def cwd() -> str:
        return os.getenv("LILY_PROJECT_ROOT", "").strip() or str(Path(__file__).resolve().parents[2])


async def _execute_task(task_id: str) -> None:
    async with _lock:
        task = _tasks.get(task_id)
        if not task or task.status not in {"approved", "running"}:
            return
        task.status = "running"
        task.progress_percent = max(task.progress_percent, 10)
        task.progress_message = "Starting tool provider."
        task.estimated_duration_seconds = task.estimated_duration_seconds or max(
            10,
            int(settings.openclaw_timeout_seconds),
        )
        task.execution_started_at = task.execution_started_at or _now()
        task.updated_at = _now()

    try:
        result = await _run_tool_agent(task)
        result_text = str(result.get("result_text") or "")
        artifacts = result.get("artifacts") if isinstance(result.get("artifacts"), list) else []
        tool_provider = str(result.get("tool_provider") or "")
        requested_provider = str(result.get("requested_provider") or "")
        fallback_used = bool(result.get("fallback_used"))
        provider_attempts = result.get("provider_attempts") if isinstance(result.get("provider_attempts"), list) else []
        status = "completed"
        error = ""
    except Exception as exc:
        result_text = ""
        artifacts = []
        tool_provider = ""
        requested_provider = ""
        fallback_used = False
        provider_attempts = []
        status = "failed"
        error = str(exc)

    if status == "completed":
        progress_percent = 100
        progress_message = "Task completed."
    else:
        progress_percent = 100
        progress_message = "Task failed."

    async with _lock:
        current = _tasks.get(task_id)
        if not current:
            return
        if current.status == "cancelled":
            _execution_tasks.pop(task_id, None)
            return
        current.status = status
        current.result_text = _sanitize_tool_result_text(result_text, artifacts)
        current.artifacts = artifacts
        current.tool_provider = tool_provider
        current.requested_provider = requested_provider
        current.fallback_used = fallback_used
        current.provider_attempts = provider_attempts
        current.error = _friendly_failure(error) if error else ""
        current.updated_at = _now()
        current.completed_at = current.updated_at
        current.execution_completed_at = current.updated_at
        current.execution_latency_ms = (
            max(0, int((current.execution_completed_at - current.execution_started_at) * 1000))
            if current.execution_started_at
            else None
        )
        current.progress_percent = progress_percent
        current.progress_message = progress_message
        current.recovery_required = bool(status == "failed" and current.delivery_target)
        _execution_tasks.pop(task_id, None)


async def create_openclaw_request(
    *,
    task: str,
    source: str,
    requester: str,
    session_id: str,
    action: str | None = None,
    require_approval: bool = False,
    delivery_channel: str | None = None,
    delivery_target: str | None = None,
    delivery_profile: str = "personal",
    input_files: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    clean_task = (task or "").strip()
    clean_source = (source or "").strip().lower()
    clean_requester = (requester or "").strip() or "owner"
    clean_session_id = (session_id or "").strip() or "owner-tools"
    clean_delivery_channel = _resolve_delivery_channel(clean_source, delivery_channel, delivery_target)
    clean_delivery_target = _resolve_delivery_target(clean_source, clean_delivery_channel, delivery_target)
    clean_delivery_profile = (delivery_profile or "personal").strip().lower() or "personal"
    if clean_source == "mobile_realm":
        clean_delivery_profile = "personal"
    if clean_delivery_profile not in {"personal", "public"}:
        clean_delivery_profile = "personal"

    if not settings.openclaw_enabled:
        return {
            "ok": False,
            "status": "disabled",
            "detail": "OpenClaw integration is disabled.",
        }
    if not clean_task:
        return {
            "ok": False,
            "status": "failed",
            "detail": "OpenClaw task is empty.",
        }
    if not is_openclaw_source_allowed(clean_source):
        return {
            "ok": False,
            "status": "blocked",
            "detail": f"OpenClaw is not allowed from source '{clean_source}'.",
        }

    normalized_action = normalize_openclaw_action(action, clean_task)
    if normalized_action not in set(settings.openclaw_allowed_actions) and normalized_action not in WRITE_ACTIONS:
        return {
            "ok": False,
            "status": "blocked",
            "detail": f"OpenClaw action '{normalized_action}' is not allowed.",
        }

    risk = classify_openclaw_risk(normalized_action, clean_task)
    approval_required = (
        bool(require_approval)
        or normalized_action in set(settings.openclaw_approval_required_actions)
        or risk != "read"
        or not settings.openclaw_auto_approve_readonly
    )

    now = _now()
    task_id = f"tool_{uuid.uuid4().hex[:10]}"
    stored_input_files = _store_input_files(task_id, input_files)
    item = OpenClawTask(
        id=task_id,
        action=normalized_action,
        task=clean_task,
        source=clean_source,
        requester=clean_requester,
        session_id=clean_session_id,
        status="pending" if approval_required else "approved",
        risk=risk,
        requires_approval=approval_required,
        created_at=now,
        updated_at=now,
        input_files=stored_input_files,
        delivery_channel=clean_delivery_channel,
        delivery_target=clean_delivery_target,
        delivery_profile=clean_delivery_profile,
        delivery_status="pending",
        approval_expires_at=now + settings.openclaw_approval_expiry_seconds if approval_required else None,
        progress_percent=0 if approval_required else 5,
        progress_message="Waiting for owner approval." if approval_required else "Queued for execution.",
        estimated_duration_seconds=max(10, int(settings.openclaw_timeout_seconds)),
    )

    async with _lock:
        _tasks[task_id] = item

    if not approval_required:
        _execution_tasks[task_id] = asyncio.create_task(_execute_task(task_id))

    return {
        "ok": True,
        "status": item.status,
        "task": item.to_public_dict(),
    }


async def approve_openclaw_request(
    task_id: str,
    approver: str = "owner",
    idempotency_key: str = "",
) -> dict[str, Any]:
    async with _lock:
        task = _tasks.get((task_id or "").strip())
        if not task:
            return {"ok": False, "status": "missing", "detail": "OpenClaw task was not found."}
        if idempotency_key and task.approval_idempotency_key == idempotency_key:
            return {"ok": True, "status": task.status, "detail": "Approval replay ignored safely.", "task": task.to_public_dict()}
        if task.status not in {"pending", "approved"}:
            return {"ok": True, "status": task.status, "task": task.to_public_dict()}
        if task.approval_expires_at and _now() >= task.approval_expires_at:
            task.status = "expired"
            task.error = "This approval expired. Create a new task to continue."
            task.completed_at = _now()
            task.updated_at = task.completed_at
            return {"ok": True, "status": "expired", "task": task.to_public_dict()}

        task.status = "approved"
        task.approved_at = _now()
        task.updated_at = task.approved_at
        task.error = ""
        task.approval_idempotency_key = idempotency_key.strip()[:120]
        task.progress_percent = max(task.progress_percent, 5)
        task.progress_message = "Approved; starting shortly."

    _execution_tasks[task.id] = asyncio.create_task(_execute_task(task.id))
    return {
        "ok": True,
        "status": "approved",
        "detail": f"OpenClaw task approved by {approver or 'owner'}.",
        "task": task.to_public_dict(),
    }


async def deny_openclaw_request(task_id: str, approver: str = "owner", reason: str = "") -> dict[str, Any]:
    async with _lock:
        task = _tasks.get((task_id or "").strip())
        if not task:
            return {"ok": False, "status": "missing", "detail": "OpenClaw task was not found."}

        task.status = "denied"
        task.error = reason.strip() or f"Denied by {approver or 'owner'}."
        task.updated_at = _now()
        task.completed_at = task.updated_at
        task.progress_percent = 100
        task.progress_message = "Task denied before execution."
        return {
            "ok": True,
            "status": "denied",
            "task": task.to_public_dict(),
        }


async def list_openclaw_requests(limit: int = 12) -> dict[str, Any]:
    async with _lock:
        tasks = sorted(_tasks.values(), key=lambda item: item.created_at, reverse=True)[: max(1, limit)]
        return {
            "ok": True,
            "items": [task.to_public_dict() for task in tasks],
        }


DELIVERY_CLAIM_TTL_SECONDS = 120.0


async def list_openclaw_deliveries(
    channel: str,
    limit: int = 8,
    delivery_profile: str = "personal",
    consumer: str = "",
) -> dict[str, Any]:
    clean_channel = (channel or "").strip().lower()
    clean_profile = (delivery_profile or "personal").strip().lower() or "personal"
    clean_consumer = (consumer or "").strip()[:80]
    now = _now()
    async with _lock:
        candidates = [
            task
            for task in _tasks.values()
            if task.delivery_channel == clean_channel
            and (task.delivery_profile or "personal") == clean_profile
            and (
                task.delivery_status == "pending"
                or (
                    task.delivery_status == "claimed"
                    and task.delivery_claimed_at is not None
                    and now - task.delivery_claimed_at >= DELIVERY_CLAIM_TTL_SECONDS
                )
            )
            and task.delivery_target
            and task.status in {"completed", "failed", "denied"}
        ]
        tasks = sorted(candidates, key=lambda item: item.updated_at)[: max(1, limit)]
        if clean_consumer:
            for task in tasks:
                task.delivery_status = "claimed"
                task.delivery_claimed_at = now
                task.delivery_claimed_by = clean_consumer
                task.updated_at = now
        return {
            "ok": True,
            "channel": clean_channel,
            "delivery_profile": clean_profile,
            "consumer": clean_consumer,
            "items": [task.to_public_dict() for task in tasks],
        }


async def mark_openclaw_delivered(
    task_id: str,
    channel: str,
    target: str = "",
    delivery_profile: str = "personal",
    consumer: str = "",
) -> dict[str, Any]:
    clean_task_id = (task_id or "").strip()
    clean_channel = (channel or "").strip().lower()
    clean_target = (target or "").strip()
    clean_profile = (delivery_profile or "personal").strip().lower() or "personal"
    clean_consumer = (consumer or "").strip()[:80]

    async with _lock:
        task = _tasks.get(clean_task_id)
        if not task:
            return {"ok": False, "status": "missing", "detail": "OpenClaw task was not found."}
        if clean_channel and task.delivery_channel != clean_channel:
            return {"ok": False, "status": "channel_mismatch", "task": task.to_public_dict()}
        if clean_target and task.delivery_target != clean_target:
            return {"ok": False, "status": "target_mismatch", "task": task.to_public_dict()}
        if (task.delivery_profile or "personal") != clean_profile:
            return {"ok": False, "status": "profile_mismatch", "task": task.to_public_dict()}
        if clean_consumer and task.delivery_status == "claimed" and task.delivery_claimed_by != clean_consumer:
            return {"ok": False, "status": "claim_mismatch", "task": task.to_public_dict()}
        if task.delivery_status == "delivered":
            return {"ok": True, "status": "delivered", "task": task.to_public_dict()}

        task.delivery_status = "delivered"
        task.delivered_at = _now()
        task.updated_at = task.delivered_at
        task.delivery_attempt_count += 1
        task.delivery_error = ""
        task.recovery_required = False
        task.delivery_latency_ms = (
            max(0, int((task.delivered_at - task.completed_at) * 1000))
            if task.completed_at
            else None
        )
        task.delivery_claimed_at = None
        task.delivery_claimed_by = ""
        return {
            "ok": True,
            "status": "delivered",
            "task": task.to_public_dict(),
        }


async def release_openclaw_delivery(
    task_id: str,
    channel: str,
    target: str = "",
    delivery_profile: str = "personal",
    consumer: str = "",
) -> dict[str, Any]:
    clean_task_id = (task_id or "").strip()
    clean_channel = (channel or "").strip().lower()
    clean_target = (target or "").strip()
    clean_profile = (delivery_profile or "personal").strip().lower() or "personal"
    clean_consumer = (consumer or "").strip()[:80]

    async with _lock:
        task = _tasks.get(clean_task_id)
        if not task:
            return {"ok": False, "status": "missing", "detail": "OpenClaw task was not found."}
        if clean_channel and task.delivery_channel != clean_channel:
            return {"ok": False, "status": "channel_mismatch", "task": task.to_public_dict()}
        if clean_target and task.delivery_target != clean_target:
            return {"ok": False, "status": "target_mismatch", "task": task.to_public_dict()}
        if (task.delivery_profile or "personal") != clean_profile:
            return {"ok": False, "status": "profile_mismatch", "task": task.to_public_dict()}
        if clean_consumer and task.delivery_claimed_by not in {"", clean_consumer}:
            return {"ok": False, "status": "claim_mismatch", "task": task.to_public_dict()}
        if task.delivery_status == "delivered":
            return {"ok": True, "status": "delivered", "task": task.to_public_dict()}

        task.delivery_status = "pending"
        task.delivery_claimed_at = None
        task.delivery_claimed_by = ""
        task.updated_at = _now()
        task.delivery_attempt_count += 1
        task.delivery_error = "Delivery lease released after a failed send."
        task.recovery_required = True
        return {"ok": True, "status": "pending", "task": task.to_public_dict()}


async def cancel_openclaw_request(task_id: str, reason: str = "Cancelled by owner.") -> dict[str, Any]:
    execution: asyncio.Task[Any] | None = None
    async with _lock:
        task = _tasks.get((task_id or "").strip())
        if not task:
            return {"ok": False, "status": "missing", "detail": "OpenClaw task was not found."}
        if task.status in {"completed", "failed", "denied", "cancelled", "expired"}:
            return {"ok": True, "status": task.status, "task": task.to_public_dict()}
        task.status = "cancelled"
        task.error = reason.strip()[:240] or "Cancelled by owner."
        task.updated_at = _now()
        task.completed_at = task.updated_at
        task.execution_completed_at = task.updated_at if task.execution_started_at else None
        task.progress_percent = 100
        task.progress_message = "Task cancelled safely."
        execution = _execution_tasks.pop(task.id, None)
        payload = task.to_public_dict()
    if execution and not execution.done():
        execution.cancel()
    return {"ok": True, "status": "cancelled", "task": payload}


async def retry_openclaw_request(
    task_id: str,
    kind: str = "execution",
    idempotency_key: str = "",
) -> dict[str, Any]:
    clean_kind = (kind or "execution").strip().lower()
    if clean_kind not in {"execution", "delivery"}:
        return {"ok": False, "status": "invalid_kind", "detail": "Retry kind must be execution or delivery."}

    async with _lock:
        task = _tasks.get((task_id or "").strip())
        if not task:
            return {"ok": False, "status": "missing", "detail": "OpenClaw task was not found."}
        if idempotency_key and task.mutation_idempotency_key == idempotency_key:
            return {"ok": True, "status": task.status, "detail": "Retry replay ignored safely.", "task": task.to_public_dict()}
        task.mutation_idempotency_key = idempotency_key.strip()[:120]
        if clean_kind == "execution":
            if task.status != "failed":
                return {"ok": True, "status": task.status, "detail": "Only failed execution tasks can be retried.", "task": task.to_public_dict()}
            task.status = "approved"
            task.error = ""
            task.result_text = ""
            task.artifacts = []
            task.provider_attempts = []
            task.retry_count += 1
            task.progress_percent = 5
            task.progress_message = "Retry queued."
            task.execution_started_at = None
            task.execution_completed_at = None
            task.execution_latency_ms = None
            task.recovery_required = False
            task.updated_at = _now()
            execution = asyncio.create_task(_execute_task(task.id))
            _execution_tasks[task.id] = execution
            return {"ok": True, "status": "approved", "task": task.to_public_dict()}

        if task.delivery_status == "delivered":
            return {"ok": True, "status": "delivered", "detail": "Artifact is already delivered.", "task": task.to_public_dict()}
        task.delivery_status = "pending"
        task.delivery_error = ""
        task.recovery_required = True
        task.delivery_attempt_count += 1
        task.updated_at = _now()
        return {"ok": True, "status": "pending", "task": task.to_public_dict()}


def get_openclaw_maintenance() -> dict[str, Any]:
    root = _artifact_root()
    now = _now()
    rows: list[tuple[OpenClawTask, dict[str, Any], Path, int, float]] = []
    for task in list(_tasks.values()):
        for artifact in task.artifacts:
            path = Path(str(artifact.get("storage_path") or ""))
            try:
                path.resolve().relative_to(root.resolve())
                stat = path.stat()
            except (OSError, ValueError):
                continue
            rows.append((task, artifact, path, stat.st_size, stat.st_mtime))
    total_bytes = sum(row[3] for row in rows)
    cutoff = now - settings.tool_artifact_retention_days * 86400
    prunable_count = sum(1 for row in rows if row[0].completed_at and row[0].completed_at <= cutoff)
    return {
        "ok": True,
        "artifact_count": len(rows),
        "artifact_bytes": total_bytes,
        "quota_bytes": settings.tool_artifact_quota_bytes,
        "quota_used_percent": round((total_bytes / settings.tool_artifact_quota_bytes) * 100, 1)
        if settings.tool_artifact_quota_bytes else 0,
        "retention_days": settings.tool_artifact_retention_days,
        "prunable_count": prunable_count,
        "last_prune_at_iso": _format_timestamp(_last_artifact_prune_at) if _last_artifact_prune_at else "",
    }


async def prune_openclaw_artifacts(dry_run: bool = False) -> dict[str, Any]:
    global _last_artifact_prune_at
    root = _artifact_root().resolve()
    now = _now()
    async with _lock:
        rows: list[tuple[OpenClawTask, dict[str, Any], Path, int]] = []
        for task in _tasks.values():
            for artifact in task.artifacts:
                path = Path(str(artifact.get("storage_path") or ""))
                try:
                    path.resolve().relative_to(root)
                    size = path.stat().st_size
                except (OSError, ValueError):
                    continue
                rows.append((task, artifact, path, size))
        total = sum(row[3] for row in rows)
        cutoff = now - settings.tool_artifact_retention_days * 86400
        candidates = [row for row in rows if row[0].completed_at and row[0].completed_at <= cutoff]
        for row in sorted(rows, key=lambda item: item[0].completed_at or item[0].created_at):
            if total <= settings.tool_artifact_quota_bytes:
                break
            if row not in candidates:
                candidates.append(row)
            total -= row[3]
        deleted = 0
        deleted_bytes = 0
        if not dry_run:
            for task, artifact, path, size in candidates:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    continue
                task.artifacts = [item for item in task.artifacts if item.get("id") != artifact.get("id")]
                deleted += 1
                deleted_bytes += size
            _last_artifact_prune_at = now
        return {
            "ok": True,
            "dry_run": dry_run,
            "candidate_count": len(candidates),
            "deleted_count": deleted,
            "deleted_bytes": deleted_bytes,
            "maintenance": get_openclaw_maintenance(),
        }


async def get_openclaw_artifact(task_id: str, artifact_id: str) -> dict[str, Any]:
    clean_task_id = (task_id or "").strip()
    clean_artifact_id = (artifact_id or "").strip()
    async with _lock:
        task = _tasks.get(clean_task_id)
        if not task:
            return {"ok": False, "status": "missing", "detail": "OpenClaw task was not found."}

        for artifact in task.artifacts:
            if str(artifact.get("id") or "") != clean_artifact_id:
                continue
            storage_path = Path(str(artifact.get("storage_path") or ""))
            if not storage_path.is_file():
                return {"ok": False, "status": "missing", "detail": "Artifact file was not found."}
            return {
                "ok": True,
                "status": "found",
                "path": storage_path,
                "artifact": public_artifact(artifact),
            }

    return {"ok": False, "status": "missing", "detail": "Artifact was not found."}


def get_openclaw_health() -> dict[str, Any]:
    cli_path, cli_label = _resolve_cli()
    tasks = list(_tasks.values())
    pending_count = sum(1 for task in tasks if task.status == "pending")
    running_count = sum(1 for task in tasks if task.status == "running")
    cli_available = bool(cli_path)
    gateway_reachable = _gateway_reachable()
    remote_health = _get_remote_tool_health() if settings.tool_agent_mode == "remote" else {}
    reported_provider = str(
        remote_health.get("provider")
        if settings.tool_agent_mode == "remote" and remote_health.get("reachable")
        else settings.tool_agent_provider
    ).strip().lower() or "openclaw"

    if not settings.openclaw_enabled:
        status = "idle"
        detail = "OpenClaw integration is disabled."
    elif settings.tool_agent_mode == "remote":
        remote_status = str(remote_health.get("status") or "offline")
        if remote_health.get("reachable") and remote_status in {"online", "degraded"}:
            status = remote_status
            detail = str(remote_health.get("detail") or "Remote tool vessel is reachable.")
        else:
            status = "degraded"
            detail = str(remote_health.get("detail") or "Remote tool vessel is not reachable.")
    elif cli_available or gateway_reachable:
        status = "online"
        detail = "OpenClaw is available through CLI or gateway."
    else:
        status = "degraded"
        detail = "OpenClaw CLI/gateway is not reachable."

    return {
        "status": status,
        "provider": reported_provider,
        "detail": detail,
        "enabled": settings.openclaw_enabled,
        "tool_agent_mode": settings.tool_agent_mode,
        "tool_agent_provider": settings.tool_agent_provider,
        "tool_agent_url": settings.tool_agent_url,
        "tool_agent_health": remote_health,
        "gateway_url": settings.openclaw_gateway_url,
        "gateway_reachable": gateway_reachable,
        "cli_available": cli_available,
        "cli_path": cli_path or cli_label,
        "allowed_sources": settings.openclaw_allowed_sources,
        "allowed_actions": settings.openclaw_allowed_actions,
        "blocked_sources": sorted(BLOCKED_SOURCES),
        "pending_count": pending_count,
        "running_count": running_count,
        "recent": [
            task.to_public_dict()
            for task in sorted(tasks, key=lambda item: item.created_at, reverse=True)[:8]
        ],
    }


def _get_remote_tool_health() -> dict[str, Any]:
    health_url = settings.tool_agent_health_url
    if not health_url:
        return {
            "reachable": False,
            "status": "offline",
            "detail": "LILY_TOOL_AGENT_HEALTH_URL is empty.",
        }

    headers = {"X-Lily-Token": settings.tool_agent_token} if settings.tool_agent_token else {}
    request = urllib.request.Request(health_url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=2.5) as response:
            payload = response.read().decode("utf-8")
            data = json.loads(payload) if payload else {}
            data["reachable"] = True
            return data
    except Exception as exc:
        return {
            "reachable": False,
            "status": "offline",
            "detail": str(exc),
        }
