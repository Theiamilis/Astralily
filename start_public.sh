#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$ROOT_DIR/lily_essence_core"
REALM_DIR="$ROOT_DIR/lily_private_realm"
CORE_PYTHON="$CORE_DIR/venv/bin/python"

[[ -x "$CORE_PYTHON" ]] || { echo "Core is not set up. Run ./setup_public.sh first." >&2; exit 1; }
[[ -d "$REALM_DIR/node_modules" ]] || { echo "Private Realm dependencies are missing. Run ./setup_public.sh first." >&2; exit 1; }

cleanup() {
  if [[ -n "${CORE_PID:-}" ]] && kill -0 "$CORE_PID" 2>/dev/null; then kill "$CORE_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

echo "Starting Lily Core and Private Realm. Press Ctrl+C to stop both."
(cd "$CORE_DIR" && exec "$CORE_PYTHON" web_server.py) & CORE_PID=$!
cd "$REALM_DIR"
exec npm run dev -- --host 127.0.0.1
