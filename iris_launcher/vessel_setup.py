"""SSH/local provisioning coordinator. Public snapshots never contain secrets."""
from __future__ import annotations

import base64
import json
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts.vessel_catalog import VESSELS
from scripts.vessel_credentials import read_private, save_private, restrict
import secrets


class VesselSetup:
    def __init__(self, runtime, transport=None):
        self.folder = Path(runtime) / "vessel-management"
        self.lock = threading.RLock()
        self.transport = transport or self.call
        self.running = False
        self.job = None

    def load(self):
        self.folder.mkdir(parents=True, exist_ok=True)
        restrict(self.folder)
        path = self.folder / "state.json"
        return read_private(path) if path.exists() else {"hosts": {}, "bindings": {}, "history": []}

    def save(self, state):
        save_private(self.folder / "state.json", state)

    @staticmethod
    def call(host, payload):
        if host["transport"] == "local":
            command = [sys.executable, str(ROOT / "scripts" / "vessel_credentials.py")]
        else:
            # Python source is encoded solely to cross cmd.exe/sh quoting safely.
            # Credentials are sent over encrypted SSH stdin, never command lines.
            code = ("import sys,runpy;from pathlib import Path;"
                    f"p=Path({host['root']!r})/'scripts';sys.path.insert(0,str(p));"
                    "runpy.run_path(str(p/'vessel_credentials.py'),run_name='__main__')")
            encoded = base64.b64encode(code.encode()).decode()
            command = ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
                       host["alias"], host["python"], "-c", f'"import base64;exec(base64.b64decode(\'{encoded}\'))"']
        try:
            result = subprocess.run(command, input=json.dumps(payload), capture_output=True, text=True,
                                    timeout=25 if payload.get("action") == "runtime-status" else 180, creationflags=0x08000000 if sys.platform == "win32" else 0)
        except (OSError, subprocess.TimeoutExpired):
            raise ValueError("Device is unreachable or still restarting; retry after checking SSH") from None
        try:
            response = json.loads(result.stdout)
        except ValueError:
            raise ValueError("Device worker unavailable; run setup_device from the updated repository and check SSH") from None
        if result.returncode or "error" in response:
            raise ValueError(response.get("error", "Device operation failed"))
        return response

    def snapshot(self):
        with self.lock:
            state = self.load()
            pending = []
            for path in self.folder.glob("operation-*.json"):
                op = read_private(path)
                if op["status"] != "complete":
                    pending.append({key: op.get(key) for key in ("id", "service", "action", "status", "step", "error")})
            return {"hosts": list(state["hosts"].values()), "bindings": state["bindings"],
                    "catalog": {key: {"consumers": sorted({c for c, _ in v.consumers})} for key, v in VESSELS.items()},
                    "operations": pending, "history": state["history"][-30:], "running": self.running, "job": self.job}

    def runtime_status(self, host):
        return self.transport(host, {"action": "runtime-status", "node_id": host["id"]})

    def bind(self, payload):
        with self.lock:
            state = self.load()
            service = payload.get("service")
            if service not in VESSELS:
                raise ValueError("Unknown vessel")
            if self.running or any(x["service"] == service for x in self.snapshot()["operations"]):
                raise ValueError("Finish or recover the existing operation first")
            owner = payload.get("owner")
            consumers = payload.get("consumers", {})
            expected = {c for c, _ in VESSELS[service].consumers}
            if set(consumers) != expected:
                raise ValueError("Select a host for each caller, or explicitly leave it unused")
            for component, host_id in [(service, owner), *consumers.items()]:
                if not host_id and component != service:
                    continue
                host = state["hosts"].get(host_id)
                if not host or component not in host["components"]:
                    raise ValueError("Selected device does not manage this component")
            state["bindings"][service] = {"owner": owner, "consumers": consumers, "status": "configured"}
            self.save(state)
            return {"saved": True}

    def start(self, payload):
        with self.lock:
            if self.running:
                raise ValueError("Another credential operation is running")
            state = self.load()
            retry = payload.get("retry")
            if retry:
                if not re.fullmatch(r"[a-f0-9]{32}", str(retry)):
                    raise ValueError("Invalid operation")
                path = self.folder / f"operation-{retry}.json"
                op = read_private(path)
                if op["status"] == "complete":
                    raise ValueError("Operation already completed")
            else:
                service, action = payload.get("service"), payload.get("action")
                if service not in state["bindings"] or action not in {"rotate", "revoke"}:
                    raise ValueError("Configure the vessel and choose Rotate or Revoke")
                if any(x["service"] == service for x in self.snapshot()["operations"]):
                    raise ValueError("Retry the existing operation before starting another")
                binding = state["bindings"][service]
                token = secrets.token_urlsafe(48)
                caller_token = secrets.token_urlsafe(48) if action == "revoke" else token
                v = VESSELS[service]
                participants = [{"host": state["hosts"][binding["owner"]], "component": service, "changes": {v.token: token}}]
                for component in sorted({c for c, _ in v.consumers}):
                    host_id = binding["consumers"].get(component)
                    if host_id:
                        participants.append({"host": state["hosts"][host_id], "component": component,
                                             "changes": {k: caller_token for c, k in v.consumers if c == component}})
                op = {"id": uuid.uuid4().hex, "service": service, "action": action, "status": "pending",
                      "step": "preflight", "participants": participants, "completed": [], "error": None}
                path = self.folder / f"operation-{op['id']}.json"
                save_private(path, op)
            self.running = True
            self.job = {"id": op["id"], "step": op["step"], "service": op["service"]}
            threading.Thread(target=self.run, args=(op, path), daemon=True).start()
            return {"id": op["id"], "started": True}

    def run(self, op, path):
        def step(action, index):
            marker = f"{action}:{index}"
            if marker in op["completed"]:
                return
            participant = op["participants"][index]
            op.update(step=f"{action} · {participant['host']['label']} · {participant['component']}", status="running", error=None)
            save_private(path, op)
            with self.lock:
                self.job = {"id": op["id"], "step": op["step"], "service": op["service"]}
            self.transport(participant["host"], {"action": action, "node_id": participant["host"]["id"],
                           "component": participant["component"], "operation": op["id"],
                           **({"changes": participant["changes"]} if action == "prepare" else {})})
            op["completed"].append(marker)
            save_private(path, op)
        try:
            for action in ("preflight", "prepare", "apply"):
                for index in range(len(op["participants"])):
                    step(action, index)
            step("verify", 0)
            # Store the new state before removing recoverable journals.
            with self.lock:
                state = self.load()
                state["bindings"][op["service"]].update(status="revoked" if op["action"] == "revoke" else "active", verified_at=time.time())
                state["history"].append({"action": op["action"], "service": op["service"], "at": time.time(), "old_token_rejected": True})
                self.save(state)
            for index in range(len(op["participants"])):
                step("cleanup", index)
            op.update(status="complete", step="verified", error=None)
            # Do not retain active or retired credentials in completed coordinator jobs.
            op.pop("participants", None)
            save_private(path, op)
        except Exception as exc:
            op.update(status="needs_attention", error=str(exc) if isinstance(exc, ValueError) else "Operation interrupted; retry after checking device availability")
            save_private(path, op)
        finally:
            with self.lock:
                self.running = False
                self.job = {key: op.get(key) for key in ("id", "service", "step", "status", "error")}
