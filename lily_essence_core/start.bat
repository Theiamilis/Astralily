@echo off
setlocal
title Lily Essence Core
color 0b

cd /d "%~dp0"

echo ==========================================
echo Lily Essence Core - Starting
echo ==========================================

if not exist "venv\Scripts\python.exe" (
    echo [!] Virtual environment is missing.
    echo Run setup.bat first.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [!] .env file is missing.
    if exist ".env.example" (
        echo Copy .env.example to .env and fill the required config.
    )
    pause
    exit /b 1
)

echo Running Lily Essence Core at http://localhost:8000
echo Press Ctrl+C to stop this service.
echo.
"venv\Scripts\python.exe" "web_server.py"
pause
endlocal
