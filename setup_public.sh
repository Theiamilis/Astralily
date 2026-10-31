#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$ROOT_DIR/lily_essence_core"
REALM_DIR="$ROOT_DIR/lily_private_realm"
CORE_ENV="$CORE_DIR/.env"
REALM_ENV="$REALM_DIR/.env"
CORE_PYTHON="$CORE_DIR/venv/bin/python"

PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  if command -v python3 >/dev/null 2>&1; then PYTHON_BIN="python3"; else PYTHON_BIN="python"; fi
fi
command -v "$PYTHON_BIN" >/dev/null 2>&1 || { echo "Python 3.10+ was not found." >&2; exit 1; }
PYTHON_VERSION="$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
"$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || { echo "Python 3.10+ is required; found $PYTHON_VERSION." >&2; exit 1; }

command -v node >/dev/null 2>&1 || { echo "Node.js 20+ was not found." >&2; exit 1; }
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
(( NODE_MAJOR >= 20 )) || { echo "Node.js 20+ is required; found $NODE_VERSION." >&2; exit 1; }

echo "Lily public setup (Python $PYTHON_VERSION, Node $NODE_VERSION)"
if [[ ! -f "$CORE_ENV" ]]; then cp "$CORE_DIR/.env.example" "$CORE_ENV"; fi
if [[ ! -f "$REALM_ENV" ]]; then cp "$REALM_DIR/.env.example" "$REALM_ENV"; fi

if [[ ! -x "$CORE_PYTHON" ]]; then
  echo "[1/4] Creating Core virtual environment..."
  "$PYTHON_BIN" -m venv "$CORE_DIR/venv"
else
  echo "[1/4] Core virtual environment already exists."
fi
echo "[2/4] Installing Core dependencies..."
"$CORE_PYTHON" -m pip install -r "$CORE_DIR/requirements.txt"
echo "[3/4] Installing Private Realm dependencies..."
npm ci --prefix "$REALM_DIR"

env_value() {
  local key="$1" file="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file" 2>/dev/null || true
}
set_env() {
  local key="$1" value="$2" file="$3"
  KEY="$key" VALUE="$value" FILE="$file" "$PYTHON_BIN" - <<'PY'
from pathlib import Path
import os, re
path = Path(os.environ["FILE"])
text = path.read_text(encoding="utf-8") if path.exists() else ""
key = os.environ["KEY"]
value = os.environ["VALUE"]
line = f"{key}={value}"
pattern = re.compile(rf"(?m)^{re.escape(key)}=.*$")
if pattern.search(text):
    text = pattern.sub(line, text)
else:
    text = text.rstrip("\r\n") + ("\n" if text else "") + line + "\n"
path.write_text(text, encoding="utf-8")
PY
}

TOKEN="$(env_value LILY_OWNER_API_TOKEN "$CORE_ENV")"
if [[ -z "$TOKEN" ]]; then TOKEN="$($PYTHON_BIN -c 'import secrets; print(secrets.token_urlsafe(32))')"; fi
set_env LILY_OWNER_API_TOKEN "$TOKEN" "$CORE_ENV"
set_env VITE_LILY_OWNER_API_TOKEN "$TOKEN" "$REALM_ENV"

echo "[4/4] Local token configured (value intentionally not printed)."
echo "Setup complete. Run ./start_public.sh and open http://localhost:5230"
