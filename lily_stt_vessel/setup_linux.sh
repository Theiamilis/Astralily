#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "[!] Python command not found: $PYTHON_BIN"
  echo "Install Python 3.10+ first, or run with PYTHON_BIN=/path/to/python."
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "[!] ffmpeg is recommended for audio decoding support."
  echo "Install ffmpeg before using WhatsApp voice note transcription."
fi

if [ ! -d "venv" ]; then
  "$PYTHON_BIN" -m venv venv
fi

source venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

echo "Lily STT Vessel setup complete. Configure Groq or use the local fLily-Voice-Host-whisper fallback."
