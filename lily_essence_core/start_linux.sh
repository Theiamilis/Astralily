#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -x "venv/bin/python" ]; then
  echo "[!] Virtual environment not found."
  echo "Run ./setup_linux.sh first."
  exit 1
fi

if [ ! -f ".env" ]; then
  echo "[!] .env not found."
  echo "Run ./setup_linux.sh or copy .env.example to .env."
  exit 1
fi

echo -ne "\033]0;Lily Essence Core\007"

mkdir -p static/audio

echo "Starting Lily Essence Core at http://0.0.0.0:8000"
exec venv/bin/python web_server.py
