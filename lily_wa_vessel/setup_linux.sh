#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js not found. Install Node.js 20+ first."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[!] npm not found. Install a complete Node.js distribution first."
  exit 1
fi

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

npm install

echo ""
echo "Lily WA Vessel setup complete."
echo "If Chromium fails to launch on Linux, install the system libraries required by Puppeteer/Chromium."
echo "Start with: ./start_linux.sh"

