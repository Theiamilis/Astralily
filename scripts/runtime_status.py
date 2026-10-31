"""Read-only installed/running build comparison; startup stamps contain no credentials."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import ctypes
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
SKIP = {"node_modules", "venv", ".venv", "runtime", "logs", "target", "build", "dist", "assets", "public", "tests", "__pycache__", "_legacy", "audio", "models", "weights", "Framework"}
EXTENSIONS = {".py", ".js", ".mjs", ".ts", ".tsx", ".css", ".html", ".rs", ".toml", ".kts", ".bat", ".sh"}
PORT_KEYS = {"core": "LILY_CORE_PORT", "wa_personal": "BRIDGE_CONTROL_PORT", "wa_public": "BRIDGE_CONTROL_PORT",
             "voice_vessel": "LILY_VOICE_VESSEL_PORT", "stream_voice_vessel": "LILY_STREAM_VOICE_PORT",
             "model_vessel": "LILY_MODEL_VESSEL_PORT", "home_vessel": "LILY_HOME_VESSEL_PORT",
             "tool_vessel": "LILY_TOOL_VESSEL_PORT", "file_vessel": "LILY_FILE_VESSEL_PORT",
             "stt_vessel": "LILY_STT_VESSEL_PORT", "finance_vessel": "LILY_FINANCE_VESSEL_PORT"}


def process_identity(pid: int) -> str | None:
    """Use process creation identity, not PID alone (PIDs can be reused)."""
    if os.name == "nt":
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetProcessTimes.argtypes = (wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4))
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            times = [wintypes.FILETIME() for _ in range(4)]
            if kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
                return str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
        finally:
            kernel.CloseHandle(handle)
        return None
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def fingerprint(component: Path) -> str:
    digest = hashlib.sha256()
    files = []
    for folder, dirs, names in os.walk(component):
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not d.startswith(".") and not Path(folder, d).is_symlink())
        for name in sorted(names):
            path = Path(folder, name)
            if path.is_symlink() or name.startswith(("test_", ".")):
                continue
            if path.suffix in EXTENSIONS or name in {"requirements.txt", "package.json", "package-lock.json"}:
                files.append(path)
    for path in sorted(files):
        digest.update(path.relative_to(component).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
    digest.update(Path(__file__).read_bytes())
    return digest.hexdigest()[:16]


def git_info(root: Path) -> dict:
    def git(*args):
        try:
            result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=5,
                                    creationflags=0x08000000 if os.name == "nt" else 0)
            return result.stdout.strip() if result.returncode == 0 else ""
        except (OSError, subprocess.TimeoutExpired):
            return ""
    return {"revision": git("rev-parse", "--short=12", "HEAD"), "branch": git("branch", "--show-current"),
            "modified": bool(git("status", "--porcelain", "--untracked-files=normal"))}


def services(root: Path) -> list[dict]:
    data = json.loads((root / "config" / "ports.json").read_text(encoding="utf-8"))
    return [s for s in data["services"] if s.get("protocol") == "tcp" and s.get("component")
            and s["id"] not in {"core_dev", "gpt_sovits"}]


def record_start(service_id: str, pid: int | None = None, root: Path = ROOT) -> dict:
    service = next(s for s in services(root) if s["id"] == service_id)
    pid = pid or os.getpid()
    identity = process_identity(pid)
    if not identity:
        raise OSError("Process identity is unavailable")
    stamp = {"service": service_id, "pid": pid, "identity": identity, "started_at": time.time(),
             "fingerprint": fingerprint(root / service["component"]), **git_info(root)}
    directory = root / "runtime" / "build-stamps"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{service_id}-{pid}.json"
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(stamp), encoding="utf-8")
    os.replace(temp, target)
    return stamp


def track_start(service_id: str) -> None:
    # Read-only installs still run; they will be reported as an unknown running build.
    try:
        record_start(service_id)
    except (OSError, ValueError, StopIteration):
        pass


def track_stop(service_id: str, root: Path = ROOT) -> None:
    try:
        (root / "runtime" / "build-stamps" / f"{service_id}-{os.getpid()}.json").unlink(missing_ok=True)
    except OSError:
        pass


def install_tracking(app, service_id: str) -> None:
    """Wrap FastAPI lifespan without replacing the service's startup/shutdown work."""
    from contextlib import asynccontextmanager
    original = app.router.lifespan_context

    @asynccontextmanager
    async def tracked_lifespan(application):
        async with original(application) as state:
            track_start(service_id)
            try:
                yield state
            finally:
                track_stop(service_id)

    app.router.lifespan_context = tracked_lifespan


def configured_port(root: Path, service: dict) -> int:
    port = int(service["port"])
    key = PORT_KEYS.get(service["id"])
    paths = [root / service["component"] / ".env"]
    if service["id"].startswith("wa_"):
        paths.append(paths[0].with_name(".env." + ("public" if service["id"] == "wa_public" else "personal")))
    for path in paths:
        if not key or not path.exists():
            continue
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == key:
                try:
                    value = int(value.strip().strip('"\''))
                    if 0 < value < 65536:
                        port = value
                except ValueError:
                    pass
    return port


def listening(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def status(root: Path = ROOT) -> dict:
    stamps = []
    for path in (root / "runtime" / "build-stamps").glob("*.json"):
        try:
            stamp = json.loads(path.read_text(encoding="utf-8"))
            if process_identity(int(stamp["pid"])) == stamp["identity"]:
                stamps.append(stamp)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    builds = {}
    def inspect(service):
        folder = root / service["component"]
        if not folder.is_dir():
            return {"id": service["id"], "label": service["label"], "state": "not_installed", "restart_required": None}
        # The same component may have personal/public instances.
        installed = builds.setdefault(service["component"], fingerprint(folder))
        active = sorted((s for s in stamps if s["service"] == service["id"]), key=lambda s: s["started_at"], reverse=True)
        port = configured_port(root, service)
        reachable = listening(port)
        return {"id": service["id"], "label": service["label"], "port": port,
                "state": "running" if active and reachable else "starting_or_unhealthy" if active else "reachable_unverified" if reachable else "stopped",
                "installed_fingerprint": installed,
                "running_fingerprint": active[0]["fingerprint"] if active else None,
                "running_revision": active[0].get("revision") if active else None,
                "started_at": active[0]["started_at"] if active else None,
                "instances": len(active),
                "restart_required": any(s["fingerprint"] != installed for s in active) if active else None}
    with ThreadPoolExecutor(max_workers=4) as executor:
        rows = list(executor.map(inspect, services(root)))
    return {"installed": git_info(root), "services": rows, "checked_at": time.time()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["status", "stamp"], nargs="?", default="status")
    parser.add_argument("service", nargs="?")
    parser.add_argument("--pid", type=int)
    args = parser.parse_args()
    print(json.dumps(record_start(args.service, args.pid) if args.action == "stamp" else status()))
