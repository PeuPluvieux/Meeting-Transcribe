@echo off
title Live Captions Bridge
echo ============================================================
echo   Live Captions Bridge for Meeting Notes AI
echo ============================================================
echo.
echo   Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Python not found. Please install Python 3.10+
    echo   Download from: https://www.python.org/downloads/
    pause
    exit /b 1
)

echo   Installing dependencies...
pip install "uiautomation>=2.0.27" "websockets>=14.0" --quiet --disable-pip-version-check >nul 2>&1

echo   Starting bridge...
echo.
python "%~dp0caption_bridge.py"
pause
