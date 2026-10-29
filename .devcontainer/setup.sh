#!/usr/bin/env bash
set -euo pipefail
pixel_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$pixel_repo/web"
if test "$(node -p 'process.versions.node.split(".")[0]')" != 24; then
  echo 'Pixel AI World requires Node 24. In Codespaces run: Dev Containers: Rebuild Container.' >&2
  exit 1
fi
npm ci --no-audit --no-fund
npm run build
# A runner/image failure must not prevent accounts, projects or Studio opening.
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  if ! docker pull node:24-bookworm-slim; then
    echo 'Website build completed. Docker image unavailable; build runner will remain disabled.' >&2
  fi
else
  echo 'Website build completed. Docker is unavailable; build runner will remain disabled.' >&2
fi
