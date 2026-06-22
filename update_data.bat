@echo off
cd /d "%~dp0"

if exist ".venv\Scripts\activate.bat" (
    call ".venv\Scripts\activate.bat"
)

python -c "import requests" 2>nul
if errorlevel 1 (
    echo Installing missing dependencies from requirements.txt...
    pip install -r requirements.txt
)

if "%~1"=="" (
    python crawler.py --refresh
) else (
    python crawler.py %*
)
pause
