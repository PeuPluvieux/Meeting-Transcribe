@echo off
title Meeting Notes AI - Launcher
color 0A
cls
echo.
echo  ==============================================================
echo   Meeting Notes AI v7.0 - One-Click Launcher
echo  ==============================================================
echo.

:: ── Find Python ──
set PYTHON_CMD=

python --version >nul 2>&1
if not errorlevel 1 set PYTHON_CMD=python

if "%PYTHON_CMD%"=="" (
    py --version >nul 2>&1
    if not errorlevel 1 set PYTHON_CMD=py
)

if "%PYTHON_CMD%"=="" (
    python3 --version >nul 2>&1
    if not errorlevel 1 set PYTHON_CMD=python3
)

if "%PYTHON_CMD%"=="" (
    echo   ERROR: Python not found. Install Python 3.10+ from https://www.python.org/downloads/
    echo   Make sure to check "Add Python to PATH" during install.
    pause
    exit /b 1
)

echo  [1/1] Starting web server on http://localhost:3000 ...
:: Kill anything already on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    taskkill /PID %%a /F >nul 2>&1
)
:: Start Python HTTP server from the web-app folder
start /min "MeetingNotesAI-Server" cmd /c "cd /d "%~dp0" && %PYTHON_CMD% -m http.server 3000 2>nul"
timeout /t 1 /nobreak >nul
echo         Web server running!
echo.
echo  ==============================================================
echo   Ready! Opening browser...
echo  ==============================================================
echo.
echo   Web App:  http://localhost:3000
echo.
echo   Mic recording: Click "Start Recording" and speak.
echo   Online meetings: Click "Add Meeting Audio", then share
echo     your Teams/Zoom window (with audio) when prompted.
echo.
echo  ==============================================================
echo.

:: Open browser
start "" "http://localhost:3000"

echo   Press any key to stop the server and exit...
pause >nul

:: Cleanup
taskkill /fi "WINDOWTITLE eq MeetingNotesAI-Server" /f >nul 2>&1
echo.
echo   Stopped. Goodbye!
