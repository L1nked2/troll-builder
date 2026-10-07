#!/bin/bash
# Move to script directory
cd "$(dirname "$0")"

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
python -m http.server 8000 --bind 127.0.0.1
