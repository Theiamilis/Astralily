#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"

echo "=========================================="
echo "Lily Essence Core - Linux setup"
echo "=========================================="

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "[!] Python command not found: $PYTHON_BIN"
  echo "Install Python 3.10+ first, or run with PYTHON_BIN=/path/to/python."
  exit 1
fi

if [ ! -d "venv" ]; then
  echo "[1/4] Creating virtual environment..."
  "$PYTHON_BIN" -m venv venv
else
  echo "[1/4] Virtual environment already exists."
fi

echo "[2/4] Installing dependencies..."
source venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo "[3/4] Preparing local runtime folders..."
mkdir -p static/audio

if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    echo "[4/4] Creating .env from .env.example..."
    cp .env.example .env
    echo "[!] Edit .env before production use, especially device URLs and LILY_OPENCLAW_WORKDIR."
  else
    echo "[4/4] .env.example not found, skipping .env creation."
  fi
else
  echo "[4/4] .env already exists."
fi

echo ""
echo "Setup complete. Start with:"
echo "  ./start_linux.sh"

