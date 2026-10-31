"""Installed/running build status for this PC, the configured Core and enrolled SSH hosts."""
from concurrent.futures import ThreadPoolExecutor
import socket
from scripts.runtime_status import status


def snapshot(root, setup, read_core):
    hosts = setup.snapshot()["hosts"]
    jobs = [("local", f"This PC · {socket.gethostname()}", lambda: status(root)),
            ("core", "Configured Core device", read_core)]
    for host in hosts:
        if host["transport"] == "ssh":
            jobs.append((host["id"], host["label"], lambda host=host: setup.runtime_status(host)))

    def inspect(job):
        device_id, label, read = job
        try:
            return {"id": device_id, "label": label, "ok": True, **read()}
        except Exception:
            # No subprocess diagnostics, host paths, tokens or upstream response bodies.
            return {"id": device_id, "label": label, "ok": False,
                    "error": "Build status unavailable. Update the service or check its trusted connection."}

    with ThreadPoolExecutor(max_workers=4) as executor:
        return {"devices": list(executor.map(inspect, jobs))}
