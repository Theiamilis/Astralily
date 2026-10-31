from typing import Any

from lily_tool_vessel.schemas import ToolRunRequest
from lily_tool_vessel.settings import ToolVesselSettings

from .base import build_agent_prompt, cli_health, resolve_cli, resolve_workdir, run_cli_command


async def run_openclaw(payload: ToolRunRequest, settings: ToolVesselSettings) -> str:
    cli_path, cli_label = resolve_cli(settings.openclaw_cli)
    if not cli_path:
        raise RuntimeError(f"OpenClaw CLI is not available on PATH as '{cli_label}'.")

    prompt = build_agent_prompt(payload, "OpenClaw")
    timeout = payload.timeout_seconds or settings.timeout_seconds
    cwd = resolve_workdir(settings.workdir)
    return await run_cli_command(
        [cli_path, "agent", "--message", prompt],
        cwd=cwd,
        timeout=timeout,
        extra_env={"OPENCLAW_HOME": settings.openclaw_home},
    )


def openclaw_health(settings: ToolVesselSettings) -> dict[str, Any]:
    payload = cli_health("openclaw", settings.openclaw_cli)
    payload["home"] = settings.openclaw_home
    return payload

