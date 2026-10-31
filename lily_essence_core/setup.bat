@echo off
setlocal
title Lily Essence Core Setup
color 0b

cd /d "%~dp0"

echo ==========================================
echo Lily Essence Core - Setup
echo ==========================================

where py >nul 2>nul
if %errorlevel%==0 (
    set "PY_CMD=py -3"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo [!] Python was not found.
        echo Install Python 3 first, then run setup.bat again.
        pause
        exit /b 1
    )
    set "PY_CMD=python"
)

if not exist "venv\Scripts\python.exe" (
    echo [1/4] Creating virtual environment...
    call %PY_CMD% -m venv venv
    if errorlevel 1 (
        echo [!] Failed to create virtual environment.
        pause
        exit /b 1
    )
) else (
    echo [1/4] Virtual environment already exists.
)

echo [2/4] Upgrade pip...
call "venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 (
    echo [!] Failed to upgrade pip.
    pause
    exit /b 1
)

echo [3/4] Installing backend dependencies...
call "venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
    echo [!] Failed to install backend dependencies.
    pause
    exit /b 1
)

if not exist ".env" (
    if exist ".env.example" (
        echo [4/4] Creating .env from .env.example ...
        copy /Y ".env.example" ".env" >nul
    ) else (
        echo [4/4] .env.example not found, skipping .env creation
    )
) else (
    echo [4/4] .env already exists.
)

echo.
echo ==========================================
echo Lily Essence Core setup complete.
echo Run start.bat to start the backend.
echo ==========================================
pause
endlocal
