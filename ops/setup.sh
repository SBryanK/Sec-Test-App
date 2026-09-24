#!/usr/bin/env bash
# One-time setup for a fresh clone.
#
#   ./ops/setup.sh
#
# Creates a project-local PostgreSQL cluster, installs dependencies, applies the
# schema and seeds the operator account. Safe to re-run: every step is
# idempotent, so it also works as a "fix my environment" script.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/env.sh"

ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✖\033[0m %s\n' "$1" >&2; exit 1; }

echo ""
echo "── Checking prerequisites ──"

command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 20 or newer."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR found, but 20 or newer is required."
ok "Node $(node -v)"

command -v npm >/dev/null 2>&1 || die "npm not found."
ok "npm $(npm -v)"

if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/pg_ctl" ]; then
  die "PostgreSQL not found. Install it, then re-run:
       macOS        brew install postgresql@18
       Debian/Ubuntu sudo apt install postgresql
     Or point PGBIN at your install in .env.local"
fi
ok "PostgreSQL at $PGBIN ($("$PGBIN/pg_ctl" --version | awk '{print $3}'))"

echo ""
echo "── PostgreSQL cluster ──"

mkdir -p "$(dirname "$PGDATA")/log" "$(dirname "$PGDATA")/sock"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "  creating a cluster at $PGDATA"
  "$PGBIN/initdb" -D "$PGDATA" -U "$PGUSER" --auth=trust --encoding=UTF8 --locale=C \
    >"$(dirname "$PGDATA")/log/initdb.log" 2>&1 \
    || die "initdb failed — see $(dirname "$PGDATA")/log/initdb.log"
  ok "cluster created"
else
  ok "cluster already exists"
fi

if "$PGBIN/pg_isready" -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
  ok "server already running on $PGHOST:$PGPORT"
else
  echo "  starting the server"
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$(dirname "$PGDATA")/log/pg.log" \
    -o "-p $PGPORT -k $(dirname "$PGDATA")/sock -c listen_addresses=127.0.0.1" start >/dev/null \
    || die "could not start PostgreSQL — see $(dirname "$PGDATA")/log/pg.log"
  for _ in $(seq 1 20); do
    "$PGBIN/pg_isready" -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1 && break
    sleep 0.5
  done
  ok "server started"
fi

if "$PGBIN/psql" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$PGDATABASE"; then
  ok "database \"$PGDATABASE\" exists"
else
  "$PGBIN/createdb" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$PGDATABASE" \
    || die "could not create database \"$PGDATABASE\""
  ok "database \"$PGDATABASE\" created"
fi

echo ""
echo "── Dependencies ──"
if [ -d node_modules ]; then
  ok "already installed (run 'npm install' to update)"
else
  echo "  installing (this takes a minute)"
  npm install >/dev/null 2>&1 || die "npm install failed — re-run it directly to see the error"
  ok "installed"
fi

echo ""
echo "── Schema ──"
npm run db:migrate >/dev/null 2>&1 || die "migration failed — run 'npm run db:migrate' to see the error"
ok "schema applied and operator account seeded"

echo ""
echo "── Ready ──"
echo ""
echo "  Start the stack:   ./ops/stack.sh"
echo "  Run the tests:     ./ops/verify.sh"
echo ""
echo "  Sign in with:      ${SEED_USER_EMAIL:-operator@example.com} / ${SEED_USER_PASSWORD:-edgeone}"
echo ""
