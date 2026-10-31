import asyncio
import os
import shutil
import subprocess
from pathlib import Path

from lily_tool_vessel.schemas import ToolRunRequest


MAX_RESULT_CHARS = 6000


def trim_result(value: str, limit: int = MAX_RESULT_CHARS) -> str:
    text = (value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}\n...[trimmed]"


def resolve_cli(configured: str) -> tuple[str | None, str]:
    if os.path.isabs(configured) and os.path.exists(configured):
        return configured, configured
    resolved = shutil.which(configured)
    return resolved, configured


def resolve_workdir(raw_workdir: str) -> str:
    workdir = Path(raw_workdir or ".").expanduser()
    if not workdir.is_absolute():
        workdir = (Path.cwd() / workdir).resolve()
    if not workdir.is_dir():
        raise RuntimeError(f"LILY_TOOL_WORKDIR does not exist: {workdir}")
    return str(workdir)


def build_agent_prompt(payload: ToolRunRequest, provider_name: str) -> str:
    artifact_instruction = ""
    if payload.artifact_dir:
        artifact_instruction = (
            "\nIf you create images, documents, reports, archives, or other files for the owner, "
            f"save them inside this artifact folder only: {payload.artifact_dir}\n"
            "Do not save Lily artifacts outside that folder.\n"
            "In your final reply, mention only the artifact filename and a short owner-facing summary. "
            "Do not mention absolute paths, relative paths, internal folders, or phrases like 'relay this to the owner'."
        )
    input_instruction = ""
    input_files = payload.input_files if isinstance(payload.input_files, list) else []
    if payload.input_dir and input_files:
        input_lines = []
        has_pdf = False
        for item in input_files:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "input").strip() or "input"
            mime_type = str(item.get("mime_type") or "application/octet-stream").strip() or "application/octet-stream"
            sha256 = str(item.get("sha256") or "").strip()
            if mime_type == "application/pdf" or name.lower().endswith(".pdf"):
                has_pdf = True
            digest_note = f", sha256 {sha256[:12]}" if sha256 else ""
            input_lines.append(f"- {name} ({mime_type}{digest_note})")
        if input_lines:
            input_instruction = (
                "\nInput files are available read-only in this folder: "
                f"{payload.input_dir}\n"
                "Use those files as source material when the task refers to an uploaded document or PDF.\n"
                "Never overwrite the input files in place. Save all final outputs to the artifact folder only.\n"
                "Input files:\n"
                + "\n".join(input_lines)
            )
            if has_pdf:
                input_instruction += (
                    "\nIf the owner asks to edit, split, merge, reorder, summarize, cover, annotate, watermark, "
                    "or convert a PDF, read the PDF from the input folder and write the edited result as a new PDF artifact."
                )
    file_task_instruction = ""
    if (payload.action or "").strip().lower() == "file_task":
        file_task_instruction = (
            "\nFor file tasks, prefer plain phrasing like: "
            "'Created <filename> with the requested content.' "
            "Avoid approval-test language, pet names, tildes, or lines like 'ready for your next command'."
        )

    return (
        f"You are {provider_name} executing a Lily AI owner-approved tool task.\n"
        f"Source: {payload.source}\n"
        f"Requester: {payload.requester}\n"
        f"Session: {payload.session_id}\n"
        f"Action: {payload.action}\n"
        f"Risk: {payload.risk}\n\n"
        "Return a concise, owner-facing result that can be sent directly in Lily chat. "
        "Do not message other people or modify files unless the task explicitly asks and approval was granted."
        f"{artifact_instruction}{input_instruction}{file_task_instruction}\n\n"
        f"Task:\n{payload.task}"
    )


def build_process_args(args: list[str]) -> list[str]:
    if os.name == "nt" and Path(args[0]).suffix.lower() in {".bat", ".cmd"}:
        command = subprocess.list2cmdline(args)
        return ["cmd.exe", "/d", "/s", "/c", f'"{command}"']
    return args


async def run_cli_command(
    args: list[str],
    *,
    cwd: str,
    timeout: int,
    extra_env: dict[str, str] | None = None,
) -> str:
    env = os.environ.copy()
    for key, value in (extra_env or {}).items():
        if value:
            env[key] = value

    process_args = build_process_args(args)
    proc = await asyncio.create_subprocess_exec(
        *process_args,
        cwd=cwd,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        proc.kill()
        await proc.communicate()
        raise RuntimeError(f"Tool agent timed out after {timeout}s.") from exc

    out = stdout.decode("utf-8", errors="replace").strip()
    err = stderr.decode("utf-8", errors="replace").strip()
    if proc.returncode != 0:
        detail = err or out or f"Tool agent exited with code {proc.returncode}."
        raise RuntimeError(trim_result(detail, 1800))

    return trim_result(out or err or "Tool agent completed without text output.")


def cli_health(name: str, configured: str) -> dict[str, str | bool | None]:
    cli_path, cli_label = resolve_cli(configured)
    return {
        "provider": name,
        "cli_available": bool(cli_path),
        "cli_path": cli_path or cli_label,
    }
