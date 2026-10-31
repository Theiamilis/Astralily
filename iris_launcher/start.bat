@echo off
setlocal
cd /d "%~dp0.."

where pyw >nul 2>nul
if %errorlevel%==0 (
    start "" pyw -3 -m iris_launcher.app
    exit /b 0
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 -m iris_launcher.app
    exit /b %errorlevel%
)

echo [!] Python 3 was not found. Install Python 3, then run this launcher again.
pause
exit /b 1

