@echo off
cd /d "%~dp0"

echo Starting Local Server at http://localhost:8000...

:: Open browser
start http://localhost:8000

:: Start Python HTTP Server
python -m http.server 8000 --bind 127.0.0.1
pause
