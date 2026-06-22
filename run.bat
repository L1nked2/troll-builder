@echo off
cd /d "%~dp0"

:: Activate virtual environment if it exists
if exist ".venv\Scripts\activate.bat" (
    echo Activating virtual environment (.venv)...
    call ".venv\Scripts\activate.bat"
    
    rem Install requirements if requests is missing
    python -c "import requests" 2>nul
    if errorlevel 1 (
        echo Installing missing dependencies from requirements.txt...
        pip install -r requirements.txt
    )
)

echo Starting Local Server at http://localhost:8000...

:: Open browser
start http://localhost:8000

:: Start Python HTTP Server
python -m http.server 8000
pause
