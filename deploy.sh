#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/appbegLedger"
SERVICE_NAME="appbeg-ledger.service"
READY_LOG="Royal VIP Coadmin foundation running at http://localhost:4300"
READY_TIMEOUT_SECONDS=30

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

service_started_at="$(systemctl show "$SERVICE_NAME" --property=ActiveEnterTimestamp --value)"
if [[ -z "$service_started_at" || "$service_started_at" == "n/a" ]]; then
  service_started_at="now"
fi

echo "== Waiting for startup readiness =="
deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
ready=false
while (( SECONDS < deadline )); do
  if systemctl is-active --quiet "$SERVICE_NAME" \
    && journalctl -u "$SERVICE_NAME" --since "$service_started_at" --no-pager | grep -Fq "$READY_LOG"; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo "Deployment timed out waiting for application readiness." >&2
  echo "== Service status =="
  systemctl status "$SERVICE_NAME" --no-pager -l || true
  echo "== Last 200 logs =="
  journalctl -u "$SERVICE_NAME" -n 200 --no-pager || true
  exit 1
fi

echo "== Service status =="
systemctl status "$SERVICE_NAME" --no-pager -l

echo "== Process tree =="
systemctl status "$SERVICE_NAME" --no-pager -l | sed -n '/CGroup:/,$p'

echo "== Startup logs =="
journalctl -u "$SERVICE_NAME" --since "$service_started_at" --no-pager

echo "Deployment successful."
