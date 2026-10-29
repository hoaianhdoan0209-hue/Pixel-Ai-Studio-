#!/usr/bin/env bash
set -euo pipefail
pixel_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATA_DIR="${DATA_DIR:-$pixel_repo/web/var}"
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3001}"
if test "$(node -p 'process.versions.node.split(".")[0]')" != 24; then
  echo 'Node 24 is required. Codespaces: Ctrl+Shift+P -> Dev Containers: Rebuild Container.' >&2
  exit 1
fi
if test -z "${BUILD_RUNNER_ENABLED:-}"; then
  export BUILD_RUNNER_ENABLED=false
  if command -v docker >/dev/null && docker info >/dev/null 2>&1 && docker image inspect node:24-bookworm-slim >/dev/null 2>&1; then
    export BUILD_RUNNER_ENABLED=true
  fi
fi
if test -n "${CODESPACE_NAME:-}" && test -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}"; then
  export PUBLIC_ORIGIN="https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  export COOKIE_SECURE=true
fi
cd "$pixel_repo/web"
# Avoid starting a duplicate process on Codespace reconnect.
if curl --fail --silent --max-time 3 "http://127.0.0.1:$PORT/api/health" | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{const h=JSON.parse(s);process.exit(h.status==="ok"&&h.database==="sqlite"?0:1)}catch{process.exit(1)}})'; then
  echo "Pixel AI World is already running on port $PORT."
  exit 0
fi
if ! test -d node_modules/tsx || ! test -f dist/index.html; then
  echo 'Preparing missing website dependencies and frontend...'
  npm ci --no-audit --no-fund
  npm run build
fi
mkdir -p "$DATA_DIR"
pixel_pid=$(node --input-type=module - <<'JS'
import {spawn} from 'node:child_process';
import {openSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const log=openSync(join(process.env.DATA_DIR,'codespace-server.log'),'a',0o600);
const child=spawn(process.execPath,['--import','tsx','server/index.ts'],{detached:true,stdio:['ignore',log,log],env:{...process.env,NODE_ENV:'production'}});
writeFileSync(join(process.env.DATA_DIR,'codespace-server.pid'),String(child.pid),{mode:0o600});
console.log(child.pid);child.unref();
JS
)
for ((pixel_attempt=0; pixel_attempt<60; pixel_attempt++)); do
  if curl --fail --silent --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null; then
    echo "Pixel AI World is ready. Open port $PORT from the Ports panel."
    exit 0
  fi
  if ! kill -0 "$pixel_pid" 2>/dev/null; then
    echo 'Server exited. Inspect web/var/codespace-server.log.' >&2
    tail -n 40 "$DATA_DIR/codespace-server.log" >&2
    exit 1
  fi
  sleep 1
done
echo 'Startup did not become ready. Inspect web/var/codespace-server.log.' >&2
exit 1
