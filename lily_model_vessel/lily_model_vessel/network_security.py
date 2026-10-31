from __future__ import annotations

from ipaddress import ip_address


def is_loopback_bind(host: str) -> bool:
    normalized = (host or "").strip().lower().strip("[]")
    if normalized == "localhost":
        return True
    try:
        return ip_address(normalized).is_loopback
    except ValueError:
        return False


def require_token_for_non_loopback(host: str, token: str, service: str) -> None:
    if is_loopback_bind(host) or (token or "").strip():
        return
    raise RuntimeError(
        f"{service} refuses to bind to {host!r} without a service token. "
        "Configure the token or bind to 127.0.0.1."
    )
