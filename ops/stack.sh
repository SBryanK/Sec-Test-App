#!/usr/bin/env bash
# Start the full local stack: API + both fixture targets (vulnerable & protected).
# Used for development and for the end-to-end test suite.
#
#   ./ops/stack.sh          # foreground, Ctrl-C stops everything
#   ./ops/stack.sh &        # background
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/env.sh"

PIDS=()

cleanup() {
  echo "[stack] shutting down…"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[stack] fixture (vulnerable) → http://127.0.0.1:9900"
MODE=vulnerable FIXTURE_PORT=9900 npx tsx apps/fixture/src/index.ts &
PIDS+=($!)

echo "[stack] fixture (protected)  → http://127.0.0.1:9901"
MODE=protected FIXTURE_PORT=9901 npx tsx apps/fixture/src/index.ts &
PIDS+=($!)

echo "[stack] api                  → http://127.0.0.1:${PORT}"
npx tsx apps/api/src/index.ts &
PIDS+=($!)

# Wait for the API to answer before declaring the stack ready.
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "[stack] ready"
    break
  fi
  sleep 0.5
done

wait
