#!/bin/bash
cd "$(dirname "$0")"

if [ -d ".venv" ]; then
  if [ -f ".venv/Scripts/activate" ]; then
    source .venv/Scripts/activate
  elif [ -f ".venv/bin/activate" ]; then
    source .venv/bin/activate
  fi
fi

if ! python -c "import requests" &>/dev/null; then
  echo "Installing missing dependencies from requirements.txt..."
  pip install -r requirements.txt
fi

python crawler.py "$@"
