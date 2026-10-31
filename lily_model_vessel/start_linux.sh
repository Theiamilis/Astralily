#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
[ -x venv/bin/python ] || { echo "Run ./setup_linux.sh first."; exit 1; }
[ -f .env ] || { echo "Copy .env.example to .env first."; exit 1; }
exec venv/bin/python app.py

