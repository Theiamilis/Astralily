@echo off
setlocal
title Lily WhatsApp Bridge Setup
color 0b

cd /d "%~dp0"

echo ==========================================
echo Lily WhatsApp Bridge - Setup
echo ==========================================

where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js was not found.
    echo Install Node.js first, then run setup.bat again.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [!] npm was not found.
    echo Make sure Node.js installation is complete.
    pause
    exit /b 1
)

if not exist ".env" (
    if exist ".env.example" (
        echo [1/3] Creating .env from .env.example ...
        copy /Y ".env.example" ".env" >nul
    ) else (
        echo [1/3] .env.example not found, skipping .env creation
    )
    echo.
) else (
    echo [1/3] .env already exists.
)

echo [2/3] Installing npm dependencies...
call npm install
if errorlevel 1 (
    echo [!] Failed to install npm dependencies.
    pause
    exit /b 1
)

echo [3/3] Validating bridge package...
if not exist "bridge.js" (
    echo [!] bridge.js was not found in this folder.
    pause
    exit /b 1
)

echo.
echo ==========================================
echo WhatsApp bridge setup complete.
echo Check .env, then run start.bat
echo ==========================================
pause
endlocal
