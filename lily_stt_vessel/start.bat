@echo off
setlocal
cd /d "%~dp0"

if not exist venv (
    echo venv not found. Running setup first...
    call setup.bat
)

call venv\Scripts\activate.bat
python app.py
pause
