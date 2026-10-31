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
echo Lily STT Vessel setup complete. Configure Groq or use the local fLily-Voice-Host-whisper fallback.
pause
