#!/usr/bin/env bash
set -euo pipefail
pixel_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$pixel_repo/web"
npm ci --no-audit --no-fund
npm run build
docker pull node:24-bookworm-slim
