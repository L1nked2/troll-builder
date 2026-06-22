#!/bin/bash
# Move to script directory
cd "$(dirname "$0")"

# Activate venv if it exists
if [ -d ".venv" ]; then
  echo "Activating virtual environment (.venv)..."
  if [ -f ".venv/Scripts/activate" ]; then
    source .venv/Scripts/activate
  elif [ -f ".venv/bin/activate" ]; then
    source .venv/bin/activate
  fi
  
  # Install requirements if requests is missing
  if ! python -c "import requests" &>/dev/null; then
    echo "Installing missing dependencies from requirements.txt..."
    pip install -r requirements.txt
  fi
fi

echo "Starting Local Server at http://localhost:8000..."

# Open default browser (handles Git Bash, WSL, and native environments)
if command -v cmd.exe &> /dev/null; then
  cmd.exe /c start http://localhost:8000
elif command -v xdg-open &> /dev/null; then
  xdg-open http://localhost:8000
elif command -v open &> /dev/null; then
  open http://localhost:8000
else
  echo "Please open http://localhost:8000 in your browser."
fi

# Run Python HTTP Server
python -m http.server 8000
