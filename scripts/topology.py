from __future__ import annotations

import argparse
import json
import socket
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
TOPOLOGY_PATH = ROOT / "config" / "topology.json"
PORTS_PATH = ROOT / "config" / "ports.json"
DEVICE_CONFIG_PATH = ROOT / ".lily-device.json"


def _load_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path.name} root must be an object")
    return payload


def load_topology(path: Path = TOPOLOGY_PATH) -> dict[str, Any]:
    return _load_object(path)


def load_ports(path: Path = PORTS_PATH) -> dict[str, Any]:
    return _load_object(path)


def component_map(ports: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for service in ports.get("services", []):
        if isinstance(service, dict) and service.get("id"):
            result[str(service["id"])] = service
    for service in ports.get("portless_components", []):
        if isinstance(service, dict) and service.get("id"):
            result[str(service["id"])] = {**service, "port": None, "protocol": "-", "kind": "portless"}
    return result


def validate_topology(topology: dict[str, Any], ports: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    devices = topology.get("devices")
    if not isinstance(devices, list) or not devices:
        return ["devices must be a non-empty list"]

    known = component_map(ports)
    device_ids: set[str] = set()
    assigned: dict[str, str] = {}
    default_power_targets: list[str] = []
    for index, device in enumerate(devices):
        if not isinstance(device, dict):
            errors.append(f"devices[{index}] must be an object")
            continue
        device_id = str(device.get("id") or "").strip()
        if not device_id:
            errors.append(f"devices[{index}] has no id")
            continue
        if device_id in device_ids:
            errors.append(f"duplicate device id: {device_id}")
        device_ids.add(device_id)

        remote_power = device.get("remote_power")
        if remote_power is not None:
            if not isinstance(remote_power, dict):
                errors.append(f"{device_id} remote_power must be an object")
            else:
                if not isinstance(remote_power.get("enabled"), bool):
                    errors.append(f"{device_id} remote_power enabled must be a boolean")
                if remote_power.get("transport") != "ssh":
                    errors.append(f"{device_id} remote_power transport must be ssh")
                if not isinstance(remote_power.get("default", False), bool):
                    errors.append(f"{device_id} remote_power default must be a boolean")
                elif remote_power.get("default"):
                    default_power_targets.append(device_id)
                if remote_power.get("platform") not in {"windows", "linux"}:
                    errors.append(f"{device_id} remote_power platform must be windows or linux")
                if remote_power.get("confirmation_required") is not True:
                    errors.append(f"{device_id} remote_power must require confirmation")
                actions = remote_power.get("allowed_actions")
                allowed_actions = {"shutdown", "restart", "hibernate", "cancel"}
                if not isinstance(actions, list) or not actions:
                    errors.append(f"{device_id} remote_power allowed_actions must be a non-empty list")
                elif any(str(action) not in allowed_actions for action in actions):
                    errors.append(f"{device_id} remote_power contains an unsupported action")
                wake_on_lan = remote_power.get("wake_on_lan")
                if wake_on_lan is not None:
                    if not isinstance(wake_on_lan, dict):
                        errors.append(f"{device_id} wake_on_lan must be an object")
                    elif wake_on_lan.get("enabled") and not str(wake_on_lan.get("mac_env") or "").strip():
                        errors.append(f"{device_id} wake_on_lan requires mac_env when enabled")
                if remote_power.get("enabled") and not str(device.get("host") or "").strip():
                    errors.append(f"{device_id} remote_power requires a host when enabled")
                if remote_power.get("enabled") and not str(remote_power.get("ssh_user") or "").strip():
                    errors.append(f"{device_id} remote_power requires ssh_user when enabled")

        services = device.get("services")
        if not isinstance(services, list):
            errors.append(f"{device_id} services must be a list")
            continue
        for service_id_value in services:
            service_id = str(service_id_value).strip()
            if service_id not in known:
                errors.append(f"{device_id} references unknown service: {service_id}")
                continue
            if service_id in assigned:
                errors.append(
                    f"service {service_id} is assigned to both {assigned[service_id]} and {device_id}"
                )
            assigned[service_id] = device_id

    for service_id in sorted(set(known) - set(assigned)):
        errors.append(f"service is not assigned to a device: {service_id}")
    if len(default_power_targets) > 1:
        errors.append("only one remote_power target may be the default")
    return errors


def _local_device_config(path: Path = DEVICE_CONFIG_PATH) -> dict[str, Any]:
    try:
        return _load_object(path)
    except (OSError, ValueError, json.JSONDecodeError):
        return {}


def current_device(topology: dict[str, Any]) -> dict[str, Any] | None:
    hostname = socket.gethostname().strip().lower()
    for device in topology.get("devices", []):
        aliases = {
            str(device.get("id") or "").lower(),
            str(device.get("host") or "").lower(),
            *(str(alias).lower() for alias in device.get("aliases", [])),
        }
        aliases.discard("")
        if hostname in aliases:
            return device

    profile = str(_local_device_config().get("profile") or "").strip().lower()
    matches = [
        device
        for device in topology.get("devices", [])
        if profile and profile in {str(item).lower() for item in device.get("profiles", [])}
    ]
    return matches[0] if len(matches) == 1 else None


def topology_rows(
    topology: dict[str, Any],
    ports: dict[str, Any],
    device_filter: str = "",
) -> list[dict[str, Any]]:
    known = component_map(ports)
    rows: list[dict[str, Any]] = []
    normalized_filter = device_filter.strip().lower()
    for device in topology["devices"]:
        device_names = {
            str(device.get("id") or "").lower(),
            str(device.get("label") or "").lower(),
            str(device.get("host") or "").lower(),
            *(str(alias).lower() for alias in device.get("aliases", [])),
        }
        device_names.discard("")
        if normalized_filter and normalized_filter not in device_names:
            continue
        services = device["services"]
        if not services:
            rows.append(
                {
                    "device_id": device["id"],
                    "device": device.get("label") or device["id"],
                    "host": str(device.get("host") or "-") or "-",
                    "profiles": ",".join(str(item) for item in device.get("profiles", [])) or "-",
                    "service_id": "-",
                    "service": "Managed device (no Lily services)",
                    "port": None,
                    "protocol": "-",
                    "endpoint": "-",
                }
            )
            continue
        for service_id in services:
            service = known[service_id]
            host = str(device.get("host") or "")
            port = service.get("port")
            health_path = str(service.get("health_path") or "")
            endpoint = f"http://{host}:{port}{health_path}" if host and port else "-"
            rows.append(
                {
                    "device_id": device["id"],
                    "device": device.get("label") or device["id"],
                    "host": host or "-",
                    "profiles": ",".join(str(item) for item in device.get("profiles", [])) or "-",
                    "service_id": service_id,
                    "service": service.get("label") or service_id,
                    "port": port,
                    "protocol": service.get("protocol") or "-",
                    "endpoint": endpoint,
                }
            )
    return rows


def _probe_host(device: dict[str, Any]) -> str:
    local = current_device({"devices": [device]})
    return "127.0.0.1" if local else str(device.get("host") or "")


def add_status(
    rows: list[dict[str, Any]],
    topology: dict[str, Any],
    timeout: float,
) -> list[dict[str, Any]]:
    devices = {str(device["id"]): device for device in topology["devices"]}
    result: list[dict[str, Any]] = []
    for row in rows:
        port = row.get("port")
        protocol = str(row.get("protocol") or "").lower()
        if row.get("service_id") == "-":
            status = "REGISTERED"
        elif not port:
            status = "PORTLESS"
        elif protocol != "tcp":
            status = "N/A"
        else:
            host = _probe_host(devices[row["device_id"]])
            try:
                with socket.create_connection((host, int(port)), timeout=timeout):
                    status = "ONLINE"
            except OSError:
                status = "OFFLINE"
        result.append({**row, "status": status})
    return result


def _print_rows(rows: list[dict[str, Any]], include_status: bool = False) -> None:
    headers = ["DEVICE", "HOST", "PROFILE", "PORT", "SERVICE"]
    if include_status:
        headers.insert(0, "STATUS")
    values: list[list[str]] = []
    for row in rows:
        rendered = [
            str(row["device"]),
            str(row["host"]),
            str(row["profiles"]),
            str(row.get("port") or "-"),
            str(row["service"]),
        ]
        if include_status:
            rendered.insert(0, str(row["status"]))
        values.append(rendered)

    widths = [len(header) for header in headers]
    for rendered in values:
        for index, value in enumerate(rendered):
            widths[index] = max(widths[index], len(value))
    print("  ".join(header.ljust(widths[index]) for index, header in enumerate(headers)))
    print("  ".join("-" * width for width in widths))
    for rendered in values:
        print("  ".join(value.ljust(widths[index]) for index, value in enumerate(rendered)))


def main() -> int:
    parser = argparse.ArgumentParser(description="Show Lily's canonical device and service topology.")
    parser.add_argument("command", nargs="?", choices=("list", "check", "status", "current"), default="list")
    parser.add_argument("--device", default="", help="Filter by device id, label, alias, or host.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    parser.add_argument("--timeout", type=float, default=0.25, help="TCP status timeout in seconds.")
    args = parser.parse_args()

    try:
        topology = load_topology()
        ports = load_ports()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"[FAIL] Could not load topology registry: {error}", file=sys.stderr)
        return 1

    errors = validate_topology(topology, ports)
    if args.command == "check":
        if errors:
            for error in errors:
                print(f"[FAIL] {error}")
            return 1
        print(
            f"[OK] {len(topology['devices'])} devices own all "
            f"{len(component_map(ports))} Lily services exactly once."
        )
        return 0
    if errors:
        for error in errors:
            print(f"[FAIL] {error}", file=sys.stderr)
        return 1

    if args.command == "current":
        device = current_device(topology)
        if not device:
            print("[WARN] Current device is not identified in config/topology.json.")
            return 2
        rows = topology_rows(topology, ports, str(device["id"]))
        if args.json:
            print(json.dumps({"device": device, "services": rows}, indent=2))
        else:
            print(f"Current device: {device.get('label') or device['id']} ({socket.gethostname()})")
            _print_rows(rows)
        return 0

    rows = topology_rows(topology, ports, args.device)
    if args.device and not rows:
        print(f"[FAIL] Unknown or empty device: {args.device}", file=sys.stderr)
        return 1
    if args.command == "status":
        rows = add_status(rows, topology, max(0.05, args.timeout))
    if args.json:
        print(json.dumps(rows, indent=2))
    else:
        _print_rows(rows, include_status=args.command == "status")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
