"""Private stdin-only worker for Launcher-managed credential rotation.

Run from a trusted SSH account or locally. Never expose this worker as HTTP.
Only catalogued token keys can be written; credentials never appear in argv.
"""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

try:
    from .vessel_catalog import FOLDERS, VESSELS, token_keys
except ImportError:
    from vessel_catalog import FOLDERS, VESSELS, token_keys

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "iris_launcher" / "runtime" / "vessel-node"


def protect(data, decrypt=False):
    if os.name != "nt":
        return data
    import ctypes
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    crypt = ctypes.windll.crypt32
    if decrypt:
        ok = crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
    else:
        ok = crypt.CryptProtectData(ctypes.byref(source), "IRIS vessel credentials", None, None, None, 1, ctypes.byref(result))
    if not ok:
        raise ValueError("OS credential protection failed")
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        ctypes.windll.kernel32.LocalFree(result.data)


def restrict(path):
    if os.name == "nt":
        result = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, text=True, check=True)
        sid = re.search(r"S-1-[0-9-]+", result.stdout).group()
        grant = f"*{sid}:" + ("(OI)(CI)F" if path.is_dir() else "F")
        subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", grant],
                       capture_output=True, check=True)
    else:
        path.chmod(0o700 if path.is_dir() else 0o600)


def private_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw = tempfile.mkstemp(prefix=".iris-", dir=path.parent)
    temporary = Path(raw)
    os.close(fd)
    try:
        restrict(temporary)
        with temporary.open("wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save_private(path, value):
    private_write(path, protect(json.dumps(value).encode()))


def read_private(path):
    return json.loads(protect(path.read_bytes(), decrypt=True))


@contextlib.contextmanager
def node_lock():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    restrict(RUNTIME)
    with (RUNTIME / "lock").open("a+b") as lock:
        lock.seek(0)
        if os.name == "nt":
            import msvcrt
            if lock.read(1) == b"":
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def env_file(component):
    if component not in FOLDERS:
        raise ValueError("Unknown component")
    path = ROOT / FOLDERS[component] / ".env"
    if path.is_symlink() or path.parent.is_symlink() or not path.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError("Linked component configuration is not supported")
    return path


def read_env(path):
    values = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if match:
            values[match[1]] = match[2].strip("\"'")
    return values


def write_keys(path, changes):
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    output, written = [], set()
    for line in lines:
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        key = match[1] if match else None
        if key in changes:
            if key not in written and changes[key] is not None:
                output.append(f"{key}={changes[key]}")
            written.add(key)
        else:
            output.append(line)
    output.extend(f"{key}={value}" for key, value in changes.items() if key not in written and value is not None)
    private_write(path, ("\n".join(output) + "\n").encode())


def unit_info(component):
    name = "lily-" + component.replace("_", "-") + ".service"
    for prefix in (["systemctl", "--user"], ["systemctl"]):
        result = subprocess.run(prefix + ["show", name, "--property=LoadState,MainPID,Restart,WorkingDirectory"],
                                capture_output=True, text=True, timeout=10)
        info = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        if info.get("LoadState") == "loaded":
            if Path(info.get("WorkingDirectory", "")).resolve() != (ROOT / FOLDERS[component]).resolve():
                raise ValueError("Service belongs to another checkout")
            return prefix, name, info
    raise ValueError("Install the component service before managing credentials")


def restart(component, check=False):
    if component == "browser":
        return
    if os.name == "nt":
        if not check:
            result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                                     str(ROOT / "scripts" / "lily.ps1"), component, "restart"],
                                      capture_output=True, timeout=150, creationflags=subprocess.CREATE_NO_WINDOW)
            if result.returncode:
                raise ValueError("Component restart failed; inspect its local service log")
        return
    prefix, unit, info = unit_info(component)
    if "--user" in prefix:
        command = prefix + ["restart", unit]
    else:
        allowed = subprocess.run(["sudo", "-n", "-l", "systemctl", "restart", unit],
                                 capture_output=True, timeout=10).returncode == 0
        if not allowed:
            pid = int(info.get("MainPID", "0"))
            if info.get("Restart") != "always" or pid <= 1 or Path(f"/proc/{pid}").stat().st_uid != os.getuid():
                raise ValueError("Service restart permission is missing; configure systemd delegation on this host")
            if not check:
                os.kill(pid, signal.SIGTERM)
            return
        command = ["sudo", "-n", "systemctl", "restart", unit]
    if not check and subprocess.run(command, capture_output=True, timeout=90).returncode:
        raise ValueError("Component restart failed; inspect its local service log")


def verify_token(service, token):
    vessel = VESSELS[service]
    env = read_env(env_file(service))
    port = int(env.get(vessel.port_key, vessel.port))
    if not 1 <= port <= 65535:
        raise ValueError("Invalid vessel port")
    # Local verification only. No redirect may carry credentials elsewhere.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    bind_host = env.get(vessel.port_key.removesuffix("_PORT") + "_HOST", "127.0.0.1")
    host = "127.0.0.1" if bind_host in {"0.0.0.0", "::", "localhost"} else bind_host
    # Pin to an address actually owned by this machine, including Tailscale-only binds.
    address = socket.getaddrinfo(host, 0, type=socket.SOCK_STREAM)[0]
    with socket.socket(address[0], socket.SOCK_STREAM) as probe:
        probe.bind(address[4])
    ip = address[4][0]
    authority = f"[{ip}]" if ":" in ip else ip
    request = urllib.request.Request(f"http://{authority}:{port}/api/auth/check",
                                     headers={"X-Lily-Token": token})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=4) as response:
            body = json.load(response)
            return 200 if body == {"authenticated": True, "service": service} else 502
    except urllib.error.HTTPError as exc:
        return exc.code
    except (OSError, ValueError):
        return 0


def handle(payload):
    action = payload.get("action")
    identity_path = RUNTIME / "identity.json"
    if not identity_path.exists():
        raise ValueError("Run setup_device on this device first")
    identity = read_private(identity_path)
    if not identity.get("enrolled") or payload.get("node_id") != identity["id"]:
        raise ValueError("Device identity mismatch or not approved")
    if action == "inspect":
        return {"id": identity["id"], "platform": sys.platform, "components": identity["components"]}
    if action == "runtime-status":
        try:
            from .runtime_status import status
        except ImportError:
            from runtime_status import status
        return status(ROOT)
    component = payload.get("component")
    if component not in identity["components"]:
        raise ValueError("Component is not managed on this device")
    path = env_file(component)
    if action == "preflight":
        current = read_env(path)
        restart(component, check=True)
        if component in VESSELS and verify_token(component, current.get(VESSELS[component].token, "")) != 200:
            raise ValueError("Start the updated vessel with its current token before rotating credentials")
        return {"ready": True}
    op = str(payload.get("operation", ""))
    if not re.fullmatch(r"[a-f0-9]{32}", op):
        raise ValueError("Invalid operation ID")
    journal = RUNTIME / (op + "-" + component + ".json")
    if action == "prepare":
        changes = payload.get("changes", {})
        if not changes or not set(changes).issubset(token_keys(component)):
            raise ValueError("Credential key is not allowed")
        if any(not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", v) for v in changes.values()):
            raise ValueError("Invalid credential")
        if journal.exists():
            saved = read_private(journal)
            if saved["changes"] != changes:
                raise ValueError("Operation already has different credentials")
        else:
            current = read_env(path)
            # Reject silent replacement of multi-target credentials.
            if component == "core" and current.get("LILY_VOICE_SERVICE_REGISTRY", "").strip() not in {"", "[]"} and "LILY_VOICE_SERVICE_TOKEN" in changes:
                raise ValueError("Multi-node Voice requires per-node credential migration first")
            if component == "wa" and current.get("LILY_FILE_VESSEL_TOKENS", "").strip() and "LILY_FILE_VESSEL_TOKEN" in changes:
                raise ValueError("Multi-target File requires per-target credential migration first")
            saved = {"old": {key: current.get(key) for key in changes}, "changes": changes, "applied": False}
            if component == "core":
                runtime_path = Path(current.get("LILY_RUNTIME_SETTINGS_PATH") or str(path.parent / "runtime" / "lily_settings.json"))
                if not runtime_path.is_absolute():
                    runtime_path = path.parent / runtime_path
                if not runtime_path.resolve().is_relative_to(path.parent.resolve()) or runtime_path.is_symlink():
                    raise ValueError("External runtime settings need a separate migration")
                if runtime_path.exists():
                    overrides = json.loads(runtime_path.read_text(encoding="utf-8"))
                    if "LILY_VOICE_SERVICE_TOKEN" in changes and overrides.get("voice_service_registry"):
                        raise ValueError("Multi-node Voice requires per-node credential migration first")
                    runtime_changes = {key.removeprefix("LILY_").lower(): value for key, value in changes.items()
                                       if key.removeprefix("LILY_").lower() in overrides}
                    saved["runtime"] = {"path": str(runtime_path), "changes": runtime_changes,
                                        "old": {key: overrides[key] for key in runtime_changes}}
            save_private(journal, saved)
        return {"prepared": True}
    if action == "cleanup" and not journal.exists():
        return {"cleaned": True}
    if not journal.exists():
        raise ValueError("Prepared credential operation not found")
    saved = read_private(journal)
    if action == "apply":
        current = read_env(path)
        expected = saved["changes"] if saved["applied"] else saved["old"]
        if any(current.get(key) != value for key, value in expected.items()):
            # Crash after atomic write, before marking applied: safe to retry.
            if any(current.get(key) != value for key, value in saved["changes"].items()):
                raise ValueError("Configuration changed since preparation; manual recovery required")
        write_keys(path, saved["changes"])
        if saved.get("runtime"):
            runtime = saved["runtime"]
            runtime_path = Path(runtime["path"])
            overrides = json.loads(runtime_path.read_text(encoding="utf-8"))
            if any(overrides.get(key) not in {runtime["old"][key], value} for key, value in runtime["changes"].items()):
                raise ValueError("Runtime configuration changed; manual recovery required")
            overrides.update(runtime["changes"])
            private_write(runtime_path, json.dumps(overrides, indent=2).encode())
        saved["applied"] = True
        save_private(journal, saved)
        restart(component)
        return {"applied": True}
    if action == "verify":
        if component not in VESSELS:
            raise ValueError("Only a vessel may verify incoming authentication")
        key = VESSELS[component].token
        new = saved["changes"][key]
        old = saved["old"].get(key) or "invalid-old-credential"
        for _ in range(20):
            if verify_token(component, new) == 200:
                break
            time.sleep(1)
        accepted = verify_token(component, new) == 200
        rejected = verify_token(component, old) == 401
        if not accepted or not rejected:
            raise ValueError("Authentication verification failed; operation is not complete")
        return {"new_accepted": True, "old_rejected": True}
    if action == "cleanup":
        journal.unlink()
        return {"cleaned": True}
    raise ValueError("Unknown credential action")


def main():
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError("Request too large")
        with node_lock():
            result = handle(json.loads(raw))
        print(json.dumps(result))
        return 0
    except Exception as exc:
        # Never include subprocess stdout/stderr or payloads in responses.
        message = str(exc) if isinstance(exc, ValueError) else "Device operation failed; check local setup and permissions"
        print(json.dumps({"error": message}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
