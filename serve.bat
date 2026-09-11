@echo off
rem Launch the kirafan-timer site with a zero-dependency Node static server.
rem Usage: serve.bat [port]   (default 8643)
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [serve.bat] Node.js not found in PATH. Install it from https://nodejs.org/
  pause
  exit /b 1
)

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8643"

start "" "http://localhost:%PORT%/"
node tools\serve.mjs %PORT%
