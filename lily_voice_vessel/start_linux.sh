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

mkdir -p static/audio
exec venv/bin/python app.py

