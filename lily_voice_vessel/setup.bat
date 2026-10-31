@echo off
setlocal
cd /d "%~dp0"

if not exist venv (
    py -3 -m venv venv
)

call venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt

if not exist .env (
    copy .env.example .env >nul
    echo Created .env from .env.example
)

echo.
echo Lily Voice Vessel setup complete.
echo Put reference voices in static\ and set model paths in .env if needed.
pause
