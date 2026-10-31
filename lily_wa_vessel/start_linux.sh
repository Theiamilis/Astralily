#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PROFILE="${1:-${LILY_WA_PROFILE:-personal}}"
if [[ "$PROFILE" != "personal" && "$PROFILE" != "public" ]]; then
  echo "[!] WA profile must be personal or public."
  exit 1
fi
export LILY_WA_PROFILE="$PROFILE"

if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js not found. Install Node.js 20+ first."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[!] node_modules not found. Run ./setup_linux.sh first."
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "[!] .env not found. Run ./setup_linux.sh or copy .env.example to .env."
  exit 1
fi

if [ "$PROFILE" = "public" ] && [ ! -f ".env.public" ]; then
  echo "[!] .env.public not found. Copy .env.public.example and pair the public number first."
  exit 1
fi

if [ "$PROFILE" = "public" ]; then
  export BRIDGE_CONTROL_PORT="${BRIDGE_CONTROL_PORT:-8093}"
  if [ "$BRIDGE_CONTROL_PORT" != "8093" ]; then
    echo "[!] Public WA must use BRIDGE_CONTROL_PORT=8093 to keep both profiles isolated."
    exit 1
  fi
fi

echo -ne "\033]0;Lily WhatsApp Vessel ($PROFILE)\007"

exec npm start
