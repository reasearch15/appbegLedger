#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/appbegLedger"
SERVICE_NAME="appbeg-ledger.service"

cd "$APP_DIR"

echo "== Git status =="
git status --short

echo "== Current commit =="
git rev-parse --short HEAD
git log -1 --oneline

echo "== Installing Node dependencies =="
npm ci

echo "== Preparing Python virtualenv =="
if [[ ! -x ".venv/bin/python" ]]; then
  python3 -m venv .venv
fi

if [[ -f "requirements.txt" ]]; then
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
else
  echo "requirements.txt not found; skipping Python dependency install."
fi

if npm pkg get scripts.migrate | grep -qv '^{}$'; then
  echo "== Running migration =="
  npm run migrate
else
  echo "No npm migrate script found; skipping migration."
fi

echo "== Restarting service =="
systemctl restart "$SERVICE_NAME"

echo "== Service status =="
systemctl status "$SERVICE_NAME" --no-pager -l

echo "== Recent logs =="
journalctl -u "$SERVICE_NAME" -n 80 --no-pager
