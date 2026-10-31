from __future__ import annotations

import json
import base64
import subprocess
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lily_tool_vessel.schemas import DevicePowerRequest, DevicePowerResponse, DevicePowerStatus
from lily_tool_vessel.settings import ToolVesselSettings


class DevicePowerError(RuntimeError):
    pass


WINDOWS_COMMANDS: dict[str, tuple[str, ...]] = {
    "shutdown": (
        "shutdown.exe", "/s", "/t", "60", "/d", "p:0:0", "/c", "Lily owner-confirmed shutdown",
    ),
    "restart": (
        "shutdown.exe", "/r", "/t", "60", "/d", "p:0:0", "/c", "Lily owner-confirmed restart",
    ),
    "hibernate": ("shutdown.exe", "/h"),
    "cancel": ("shutdown.exe", "/a"),
}

LINUX_COMMANDS: dict[str, tuple[str, ...]] = {
    "shutdown": ("sudo", "-n", "systemctl", "poweroff"),
    "restart": ("sudo", "-n", "systemctl", "reboot"),
    "hibernate": ("sudo", "-n", "systemctl", "hibernate"),
    "cancel": ("true",),
}

RESTRICTED_WINDOWS_COMMANDS: dict[str, tuple[str, ...]] = {
    "shutdown": ("lily-power", "shutdown"),
    "restart": ("lily-power", "restart"),
    "hibernate": ("lily-power", "hibernate"),
    "cancel": ("lily-power", "cancel"),
}

WINDOWS_STATUS_SCRIPT = """
$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average
$boot = $os.LastBootUpTime
$cpuValue = if ($null -eq $cpu.Average) { 0 } else { $cpu.Average }
$result = [ordered]@{
  hostname = $env:COMPUTERNAME
  logged_in_user = [string]$computer.UserName
  uptime_seconds = [int64]((Get-Date) - $boot).TotalSeconds
  cpu_percent = [double]$cpuValue
  memory_total_bytes = [int64]$os.TotalVisibleMemorySize * 1024
  memory_used_bytes = [int64]($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) * 1024
  boot_time = $boot.ToUniversalTime().ToString('o')
}
$result | ConvertTo-Json -Compress
""".strip()


def _load_topology(path: str) -> dict[str, Any]:
    topology_path = Path(path).expanduser().resolve()
    try:
        payload = json.loads(topology_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DevicePowerError(f"Could not load the device registry: {error}") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("devices"), list):
        raise DevicePowerError("The device registry is invalid.")
    return payload


def list_power_targets(settings: ToolVesselSettings) -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    for device in _load_topology(settings.device_power_topology)["devices"]:
        if not isinstance(device, dict):
            continue
        power = device.get("remote_power")
        if not isinstance(power, dict):
            continue
        targets.append(
            {
                "id": str(device.get("id") or ""),
                "label": str(device.get("label") or device.get("id") or ""),
                "host": str(device.get("host") or ""),
                "enabled": power.get("enabled") is True,
                "default": power.get("default") is True,
                "platform": str(power.get("platform") or ""),
                "transport": str(power.get("transport") or ""),
                "ssh_user": str(power.get("ssh_user") or ""),
                "confirmation_required": power.get("confirmation_required") is True,
                "allowed_actions": [str(action) for action in power.get("allowed_actions", [])],
                "aliases": [str(alias) for alias in device.get("aliases", [])],
            }
        )
    return targets


def resolve_power_target(target_name: str, settings: ToolVesselSettings) -> dict[str, Any]:
    normalized = target_name.strip().lower()
    for target in list_power_targets(settings):
        names = {
            target["id"].lower(),
            target["label"].lower(),
            target["host"].lower(),
            *(alias.lower() for alias in target["aliases"]),
        }
        names.discard("")
        if normalized in names:
            return target
    raise DevicePowerError("The requested power target is not registered.")


def build_ssh_command(request: DevicePowerRequest, target: dict[str, Any], settings: ToolVesselSettings) -> list[str]:
    if not target.get("enabled"):
        raise DevicePowerError(f"Remote power is not enabled for {target['label']}.")
    if target.get("transport") != "ssh":
        raise DevicePowerError("Only the SSH remote-power transport is supported.")
    if not target.get("confirmation_required"):
        raise DevicePowerError("The target has an unsafe confirmation policy.")
    if request.action not in set(target.get("allowed_actions") or []):
        raise DevicePowerError(f"Action {request.action} is not allowed for {target['label']}.")

    if target.get("platform") == "windows" and str(target.get("ssh_user") or "").lower() == "lily-power":
        command_table = RESTRICTED_WINDOWS_COMMANDS
    else:
        command_table = WINDOWS_COMMANDS if target.get("platform") == "windows" else LINUX_COMMANDS
    remote_command = command_table.get(request.action)
    if not remote_command:
        raise DevicePowerError("The requested action is unsupported on this platform.")

    host = str(target.get("host") or "").strip()
    ssh_user = str(target.get("ssh_user") or "").strip()
    if not host or not ssh_user:
        raise DevicePowerError("The target SSH identity is incomplete.")

    destination = f"{ssh_user}@{host}"
    return [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", f"ConnectTimeout={max(3, settings.device_power_ssh_timeout_seconds)}",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "LogLevel=ERROR",
        destination,
        *remote_command,
    ]


def append_power_audit(settings: ToolVesselSettings, payload: dict[str, Any]) -> dict[str, Any]:
    audit_path = Path(settings.device_power_audit_path).expanduser().resolve()
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    record = {"timestamp": datetime.now(timezone.utc).isoformat(), **payload}
    with audit_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=True) + "\n")
    return record


def read_power_history(
    settings: ToolVesselSettings,
    *,
    limit: int = 30,
    target: str = "",
) -> list[dict[str, Any]]:
    audit_path = Path(settings.device_power_audit_path).expanduser().resolve()
    if not audit_path.exists():
        return []

    normalized_target = target.strip().lower()
    records: deque[dict[str, Any]] = deque(maxlen=max(1, min(limit, 200)))
    try:
        with audit_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    item = json.loads(line)
                except (TypeError, ValueError):
                    continue
                if not isinstance(item, dict):
                    continue
                if normalized_target and str(item.get("target") or "").lower() != normalized_target:
                    continue
                records.append(item)
    except OSError as error:
        raise DevicePowerError(f"Could not read the power history: {error}") from error
    return list(reversed(records))


def _ssh_prefix(target: dict[str, Any], settings: ToolVesselSettings) -> list[str]:
    host = str(target.get("host") or "").strip()
    ssh_user = str(target.get("ssh_user") or "").strip()
    if not host or not ssh_user:
        raise DevicePowerError("The target SSH identity is incomplete.")
    return [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", f"ConnectTimeout={max(3, settings.device_power_ssh_timeout_seconds)}",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "LogLevel=ERROR",
        f"{ssh_user}@{host}",
    ]


def build_status_command(target: dict[str, Any], settings: ToolVesselSettings) -> list[str]:
    if not target.get("enabled"):
        raise DevicePowerError(f"Remote power is not enabled for {target['label']}.")
    if target.get("transport") != "ssh":
        raise DevicePowerError("Only the SSH remote-power transport is supported.")
    if target.get("platform") == "windows":
        if str(target.get("ssh_user") or "").lower() == "lily-power":
            return [*_ssh_prefix(target, settings), "lily-power", "status"]
        encoded = base64.b64encode(WINDOWS_STATUS_SCRIPT.encode("utf-16le")).decode("ascii")
        return [*_ssh_prefix(target, settings), "powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]
    return [*_ssh_prefix(target, settings), "sh", "-lc", "printf '{\"hostname\":\"%s\",\"uptime_seconds\":%s}' \"$(hostname)\" \"$(cut -d. -f1 /proc/uptime)\""]


def get_device_power_status(target_name: str, settings: ToolVesselSettings) -> DevicePowerStatus:
    target = resolve_power_target(target_name, settings)
    started = time.perf_counter()
    checked_at = datetime.now(timezone.utc).isoformat()
    try:
        completed = subprocess.run(
            build_status_command(target, settings),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=max(5, settings.device_power_ssh_timeout_seconds + 5),
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return DevicePowerStatus(
            target_id=target["id"],
            target_label=target["label"],
            online=False,
            checked_at=checked_at,
            latency_ms=int((time.perf_counter() - started) * 1000),
            detail=str(error)[:240],
        )

    latency_ms = int((time.perf_counter() - started) * 1000)
    if completed.returncode != 0:
        detail = " ".join((completed.stderr or completed.stdout or "").split())[:240]
        return DevicePowerStatus(
            target_id=target["id"],
            target_label=target["label"],
            online=False,
            checked_at=checked_at,
            latency_ms=latency_ms,
            detail=detail or f"SSH exited with code {completed.returncode}.",
        )

    raw_output = (completed.stdout or "").strip()
    try:
        payload = json.loads(raw_output)
    except (TypeError, ValueError):
        payload = {}
    return DevicePowerStatus(
        target_id=target["id"],
        target_label=target["label"],
        online=True,
        hostname=str(payload.get("hostname") or target.get("host") or ""),
        logged_in_user=str(payload.get("logged_in_user") or ""),
        uptime_seconds=int(payload["uptime_seconds"]) if payload.get("uptime_seconds") is not None else None,
        cpu_percent=float(payload["cpu_percent"]) if payload.get("cpu_percent") is not None else None,
        memory_used_bytes=int(payload["memory_used_bytes"]) if payload.get("memory_used_bytes") is not None else None,
        memory_total_bytes=int(payload["memory_total_bytes"]) if payload.get("memory_total_bytes") is not None else None,
        boot_time=str(payload.get("boot_time") or ""),
        checked_at=checked_at,
        latency_ms=latency_ms,
        detail="Connected through restricted SSH.",
    )


def execute_device_power(request: DevicePowerRequest, settings: ToolVesselSettings) -> DevicePowerResponse:
    target = resolve_power_target(request.target, settings)
    command = build_ssh_command(request, target, settings)
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=max(5, settings.device_power_ssh_timeout_seconds + 5),
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        append_power_audit(
            settings,
            {"target": target["id"], "action": request.action, "source": request.source, "ok": False},
        )
        raise DevicePowerError(f"SSH power execution failed: {error}") from error

    duration_ms = int((time.perf_counter() - started) * 1000)
    output = " ".join((completed.stdout or completed.stderr or "").split())[:240]
    cancel_without_pending = request.action == "cancel" and completed.returncode != 0 and "1116" in output
    ok = completed.returncode == 0 or cancel_without_pending
    append_power_audit(
        settings,
        {
            "target": target["id"],
            "action": request.action,
            "source": request.source,
            "ok": ok,
            "return_code": completed.returncode,
            "duration_ms": duration_ms,
        },
    )
    if not ok:
        raise DevicePowerError(output or f"SSH exited with code {completed.returncode}.")

    detail = "No scheduled shutdown was active." if cancel_without_pending else f"{request.action} accepted by {target['label']}."
    return DevicePowerResponse(
        ok=True,
        status="completed",
        target_id=target["id"],
        target_label=target["label"],
        action=request.action,
        detail=detail,
        duration_ms=duration_ms,
    )
