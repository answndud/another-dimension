#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

node --check apps/web/src/main.js
node --check apps/web/src/relay-room.js
node --check apps/web/notification-worker.js
test -f apps/web/index.html
test -f apps/web/src/styles.css
printf '%s\n' 'Static web checks passed.'
