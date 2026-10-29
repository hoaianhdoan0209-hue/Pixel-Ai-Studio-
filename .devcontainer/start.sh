#!/usr/bin/env bash
set -euo pipefail
pixel_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATA_DIR="${DATA_DIR:-$pixel_repo/web/var}"
export HOST=0.0.0.0
export PORT=3001
export BUILD_RUNNER_ENABLED=true
if test -n "${CODESPACE_NAME:-}" && test -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}"; then
  export PUBLIC_ORIGIN="https://${CODESPACE_NAME}-3001.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  export COOKIE_SECURE=true
fi
cd "$pixel_repo/web"
# Avoid starting a duplicate process on Codespace reconnect.
if curl --fail --silent http://127.0.0.1:3001/api/health >/dev/null; then
  echo 'Pixel AI World is already running on port 3001.'
  exit 0
fi
mkdir -p "$DATA_DIR"
nohup npm start > "$DATA_DIR/codespace-server.log" 2>&1 < /dev/null &
pixel_pid=$!
for ((pixel_attempt=0; pixel_attempt<60; pixel_attempt++)); do
  if curl --fail --silent http://127.0.0.1:3001/api/health >/dev/null; then
    echo 'Pixel AI World is ready. Open port 3001 from the Ports panel.'
    exit 0
  fi
  if ! kill -0 "$pixel_pid" 2>/dev/null; then
    echo 'Server exited. Inspect web/var/codespace-server.log.' >&2
    exit 1
  fi
  sleep 1
done
echo 'Startup did not become ready. Inspect web/var/codespace-server.log.' >&2
exit 1
