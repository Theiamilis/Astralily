#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "[!] node_modules not found. Run ./setup_linux.sh first."
  exit 1
fi

exec npm run dev -- --host 0.0.0.0

