@echo off
setlocal
set "IRIS_NATIVE_EXE=%~dp0iris_launcher\dist\IRIS Launcher.exe"

if exist "%IRIS_NATIVE_EXE%" (
    start "" "%IRIS_NATIVE_EXE%"
    exit /b 0
)

call "%~dp0iris_launcher\start.bat"
