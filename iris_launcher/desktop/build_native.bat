@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
    call npm install
    if errorlevel 1 exit /b 1
)

call npm run build
if errorlevel 1 exit /b %errorlevel%

if not exist "..\dist" mkdir "..\dist"
copy /y "src-tauri\target\release\iris-launcher.exe" "..\dist\IRIS Launcher.exe" >nul
if errorlevel 1 exit /b %errorlevel%

echo IRIS Launcher built at iris_launcher\dist\IRIS Launcher.exe
