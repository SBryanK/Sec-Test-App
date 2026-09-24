#!/usr/bin/env bash
# One-command verification of the whole stack.
#
#   1. typecheck every workspace
#   2. start the stack if it is not already running
#   3. run unit tests, engine E2E, and API integration tests
#   4. print a pass/fail summary
#
# Usage:  ./ops/verify.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/env.sh"

STARTED_STACK=0
FAILURES=0

cleanup() {
  if [ "$STARTED_STACK" = "1" ]; then
    echo ""
    echo "── stopping the stack this script started ──"
    pkill -f "ops/stack.sh" 2>/dev/null || true
    pkill -f "apps/fixture/src/index.ts" 2>/dev/null || true
    pkill -f "tsx apps/api/src/index.ts" 2>/dev/null || true
  fi
}
trap cleanup EXIT

section() { printf '\n\033[1m── %s ──\033[0m\n' "$1"; }
pass()    { printf '  \033[32m✔\033[0m %s\n' "$1"; }
fail()    { printf '  \033[31m✖\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# --------------------------------------------------------------------------
section "Postgres"
if "$PGBIN/pg_isready" -h 127.0.0.1 -p 55432 >/dev/null 2>&1; then
  pass "reachable on 127.0.0.1:55432"
else
  echo "  starting workspace-local cluster…"
  pg_start >/dev/null 2>&1 || true
  sleep 3
  if "$PGBIN/pg_isready" -h 127.0.0.1 -p 55432 >/dev/null 2>&1; then
    pass "started"
  else
    fail "could not start Postgres"
  fi
fi

# --------------------------------------------------------------------------
section "Typecheck"
if npm run typecheck >/tmp/teo-typecheck.log 2>&1; then
  pass "all workspaces typecheck clean"
else
  fail "typecheck failed (see /tmp/teo-typecheck.log)"
  tail -20 /tmp/teo-typecheck.log
fi

# --------------------------------------------------------------------------
section "Stack"
if curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  pass "API already running on :${PORT}"
else
  echo "  starting API + fixtures…"
  nohup ./ops/stack.sh >/tmp/teo-stack.log 2>&1 &
  STARTED_STACK=1
  for _ in $(seq 1 40); do
    curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    pass "API started"
  else
    fail "API did not start (see /tmp/teo-stack.log)"
  fi
fi

# --------------------------------------------------------------------------
run_suite() {
  local name="$1" file="$2"
  section "$name"
  if npx tsx --test "$file" >/tmp/teo-$name.log 2>&1; then
    local counts
    counts=$(grep -E "^ℹ (tests|pass|fail) " /tmp/teo-$name.log | tr '\n' ' ')
    pass "$counts"
  else
    fail "suite failed — see /tmp/teo-$name.log"
    grep -E "^✖" /tmp/teo-$name.log | head -10
  fi
}

# The suites execute real (charged) runs, so make sure the test account can
# afford them rather than failing later with an opaque HTTP 402.
npm run credits:topup -- 500 >/dev/null 2>&1 || true

# The engine suites talk to the fixture directly; `check-live` goes through the
# API, so it needs the base URL the app would use.
export API_URL="${API_URL:-$(api_url)}"
export FIXTURE_URL="${FIXTURE_URL:-http://127.0.0.1:9900}"

run_suite "detectors"   "apps/api/test/detectors.test.ts"
run_suite "fingerprint" "apps/api/test/fingerprint.test.ts"
run_suite "anonymity"   "apps/api/test/anonymity.test.ts"
run_suite "concurrency" "apps/api/test/concurrency.test.ts"
run_suite "engine-e2e"  "apps/api/test/engine.e2e.test.ts"
run_suite "catalog"     "packages/shared/test/catalog.test.ts"
run_suite "api"         "apps/api/test/api.integration.test.ts"
run_suite "access"      "apps/api/test/access-control.test.ts"

# --------------------------------------------------------------------------
section "Production build"
if npm run build:api >/tmp/teo-build.log 2>&1; then
  pass "bundle built ($(du -h apps/api/dist/index.js | cut -f1))"
  # The bundle exiting immediately after startup was a real regression once.
  # Assert it actually stays up and serves a request.
  # A distinct port: the dev API is usually already holding $PORT.
  PORT=$((PORT + 1)) node apps/api/dist/index.js >/tmp/teo-bundle.log 2>&1 &
  BUNDLE_PID=$!
  sleep 7
  if kill -0 $BUNDLE_PID 2>/dev/null && curl -fsS -m 3 "http://127.0.0.1:$((PORT + 1))/api/health" >/dev/null 2>&1; then
    pass "bundle stays up and serves /api/health"
  else
    fail "bundle did not stay up — see /tmp/teo-bundle.log"
    tail -10 /tmp/teo-bundle.log
  fi
  kill $BUNDLE_PID 2>/dev/null || true
  sleep 1
else
  fail "build failed — see /tmp/teo-build.log"
  tail -10 /tmp/teo-build.log
fi
run_suite "ui-contract" "apps/mobile/test/ui-contract.test.ts"
run_suite "api-client"  "apps/mobile/test/api-client.test.ts"

# Live behavioural checks: what the *target* observed and what the *ledger*
# recorded. These need the stack up (the step above starts it) and they consume
# real credits against the local fixture, which is exactly the point — a unit
# test cannot prove that the recorded User-Agent is the one that was sent.
run_suite "live"        "ops/check-live.ts"

# --------------------------------------------------------------------------
section "Result"
if [ "$FAILURES" -eq 0 ]; then
  printf '  \033[32mALL CHECKS PASSED\033[0m\n\n'
  exit 0
fi
printf '  \033[31m%d CHECK(S) FAILED\033[0m\n\n' "$FAILURES"
exit 1
