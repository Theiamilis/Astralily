@echo off
setlocal
title Lily WhatsApp Bridge (Windows)
color 0b

cd /d "%~dp0"

echo ==========================================
echo Lily WhatsApp Bridge - Starting...
echo ==========================================

where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js was not found.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [!] Dependencies are not installed.
    echo Run setup.bat first.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [!] .env file is missing.
    if exist ".env.example" (
        echo Copy .env.example to .env and fill the config.
    )
    pause
    exit /b 1
)

echo Cleaning old bridge processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$bridgePath = (Resolve-Path '.\\bridge.js').Path; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like ('*' + $bridgePath + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\.cache\\puppeteer\\chrome\\*' } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }"
echo Old processes cleaned.
echo.
node bridge.js
pause
endlocal
