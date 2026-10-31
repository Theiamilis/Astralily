#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -x "venv/bin/python" ]; then
  echo "[!] Virtual environment not found. Run ./setup_linux.sh first."
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "[!] .env not found. Run ./setup_linux.sh or copy .env.example to .env."
  exit 1
fi

echo -ne "\033]0;Lily STT Vessel\007"

exec venv/bin/python app.py
