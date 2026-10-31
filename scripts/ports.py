from __future__ import annotations

import argparse
import json
import socket
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REGISTRY_PATH = ROOT / "config" / "ports.json"


def load_registry(path: Path = REGISTRY_PATH) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Port registry root must be an object.")
    return payload


def service_map(registry: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    source = registry or load_registry()
    return {
        str(service["id"]): service
        for service in source.get("services", [])
        if isinstance(service, dict) and service.get("id")
    }


def service_port(service_id: str, fallback: int | None = None) -> int:
    service = service_map().get(service_id)
    if service and isinstance(service.get("port"), int):
        return int(service["port"])
    if fallback is not None:
        return fallback
    raise KeyError(f"Unknown Lily service id: {service_id}")


def validate_registry(registry: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    services = registry.get("services")
    if not isinstance(services, list) or not services:
        return ["services must be a non-empty list"]

    ids: set[str] = set()
    bindings: set[tuple[str, int]] = set()
    retired = {
        int(item["port"])
        for item in registry.get("retired_ports", [])
        if isinstance(item, dict) and isinstance(item.get("port"), int)
    }
    policy = registry.get("policy") if isinstance(registry.get("policy"), dict) else {}
    kind_ranges = {
        "frontend": policy.get("frontend_range"),
        "core": policy.get("core_range"),
        "bridge_tool": policy.get("bridge_tool_range"),
        "vessel_media": policy.get("vessel_media_range"),
    }

    for index, service in enumerate(services):
        if not isinstance(service, dict):
            errors.append(f"services[{index}] must be an object")
            continue
        service_id = str(service.get("id") or "").strip()
        if not service_id:
            errors.append(f"services[{index}] has no id")
        elif service_id in ids:
            errors.append(f"duplicate service id: {service_id}")
        ids.add(service_id)

        port = service.get("port")
        protocol = str(service.get("protocol") or "tcp").lower()
        if not isinstance(port, int) or not 1 <= port <= 65535:
            errors.append(f"{service_id or index} has invalid port: {port!r}")
            continue
        binding = (protocol, port)
        if binding in bindings:
            errors.append(f"duplicate owned binding: {protocol}/{port}")
        bindings.add(binding)
        if port in retired:
            errors.append(f"{service_id} uses retired port {port}")

        expected_range = kind_ranges.get(str(service.get("kind") or ""))
        if (
            isinstance(expected_range, list)
            and len(expected_range) == 2
            and all(isinstance(value, int) for value in expected_range)
            and not expected_range[0] <= port <= expected_range[1]
        ):
            errors.append(
                f"{service_id} port {port} is outside its {service.get('kind')} range "
                f"{expected_range[0]}-{expected_range[1]}"
            )

    portless_ids: set[str] = set()
    for item in registry.get("portless_components", []):
        if not isinstance(item, dict) or not str(item.get("id") or "").strip():
            errors.append("portless component has no id")
            continue
        item_id = str(item["id"])
        if item_id in ids or item_id in portless_ids:
            errors.append(f"duplicate component id: {item_id}")
        portless_ids.add(item_id)

    return errors


def _is_listening(host: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def status_rows(registry: dict[str, Any], host: str, timeout: float) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for service in registry["services"]:
        protocol = str(service.get("protocol") or "tcp").lower()
        listening = _is_listening(host, int(service["port"]), timeout) if protocol == "tcp" else None
        rows.append({**service, "host": host, "listening": listening})
    return rows


def _print_table(rows: list[dict[str, Any]], include_status: bool = False) -> None:
    headers = ["PORT", "PROTO", "KIND", "SERVICE", "COMPONENT"]
    if include_status:
        headers.insert(0, "STATUS")
    rendered: list[list[str]] = []
    for row in rows:
        values = [
            str(row.get("port") or "-"),
            str(row.get("protocol") or "-").upper(),
            str(row.get("kind") or "-"),
            str(row.get("label") or row.get("id") or "-"),
            str(row.get("component") or "external"),
        ]
        if include_status:
            listening = row.get("listening")
            values.insert(0, "ONLINE" if listening is True else "OFFLINE" if listening is False else "N/A")
        rendered.append(values)

    widths = [len(header) for header in headers]
    for values in rendered:
        for index, value in enumerate(values):
            widths[index] = max(widths[index], len(value))
    print("  ".join(header.ljust(widths[index]) for index, header in enumerate(headers)))
    print("  ".join("-" * width for width in widths))
    for values in rendered:
        print("  ".join(value.ljust(widths[index]) for index, value in enumerate(values)))


def main() -> int:
    parser = argparse.ArgumentParser(description="List and validate Lily's canonical port allocation.")
    parser.add_argument("command", nargs="?", choices=("list", "check", "status"), default="list")
    parser.add_argument("--all", action="store_true", help="Include external dependencies and portless components.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    parser.add_argument("--host", default="127.0.0.1", help="Host used by the status command.")
    parser.add_argument("--timeout", type=float, default=0.2, help="TCP probe timeout in seconds.")
    args = parser.parse_args()

    try:
        registry = load_registry()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"[FAIL] Could not load {REGISTRY_PATH}: {error}", file=sys.stderr)
        return 1

    errors = validate_registry(registry)
    if args.command == "check":
        if errors:
            for error in errors:
                print(f"[FAIL] {error}")
            return 1
        print(f"[OK] {len(registry['services'])} Lily-owned ports are unique and within policy ranges.")
        return 0
    if errors:
        for error in errors:
            print(f"[FAIL] {error}", file=sys.stderr)
        return 1

    if args.command == "status":
        rows = status_rows(registry, args.host, max(0.05, args.timeout))
        if args.json:
            print(json.dumps(rows, indent=2))
        else:
            _print_table(rows, include_status=True)
        return 0

    rows = list(registry["services"])
    if args.all:
        rows.extend(
            {
                **item,
                "kind": "external",
                "component": "external dependency",
            }
            for item in registry.get("external_dependencies", [])
        )
    if args.json:
        payload: dict[str, Any] = {"services": rows}
        if args.all:
            payload["portless_components"] = registry.get("portless_components", [])
            payload["retired_ports"] = registry.get("retired_ports", [])
        print(json.dumps(payload, indent=2))
    else:
        _print_table(rows)
        if args.all:
            print("\nPORTLESS COMPONENTS")
            for item in registry.get("portless_components", []):
                print(f"- {item['label']} ({item['component']}): {item['reason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
