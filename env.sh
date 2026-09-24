# Source this before running npm / node / API commands for the TEO SecTest project.
#
#   source env.sh
#
# Everything below is derived from this file's own location, so the repo works
# from any checkout path, on any machine, with no edits. Machine-specific
# overrides go in .env.local (gitignored), which is loaded first so it can
# influence the defaults computed below.

# --- Project root ----------------------------------------------------------
# Resolved from BASH_SOURCE, not hardcoded, so a clone anywhere just works.
TEO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TEO_ROOT

# --- Machine-local overrides (gitignored) ----------------------------------
# Loaded BEFORE the defaults so an override actually takes effect. Create
# .env.local next to this file to set any of the variables below, e.g.:
#
#   export TEO_PGDATA="$HOME/.teo-pg/data"
#   export TEO_NPM_CACHE="$HOME/.cache/teo-npm"
#   export PGBIN=/usr/lib/postgresql/16/bin
#   export ANDROID_TOOLCHAIN_HOME="$HOME/android-toolchain"
#
if [ -f "$TEO_ROOT/.env.local" ]; then
  # shellcheck disable=SC1091
  source "$TEO_ROOT/.env.local"
fi

# --- npm -------------------------------------------------------------------
# Uses npm's normal cache under $HOME by default. TEO_NPM_CACHE is only needed
# in environments where $HOME is not writable (some sandboxes, CI).
if [ -n "${TEO_NPM_CACHE:-}" ]; then
  export npm_config_cache="$TEO_NPM_CACHE"
  export npm_config_logs_dir="$TEO_NPM_CACHE/_logs"
fi

# --- Postgres (project-local cluster) --------------------------------------
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-55432}"
export PGUSER="${PGUSER:-teo}"
export PGDATABASE="${PGDATABASE:-teo_sectest}"
export PGDATA="${TEO_PGDATA:-$TEO_ROOT/.teo-pg/data}"
export DATABASE_URL="${DATABASE_URL:-postgres://$PGUSER@$PGHOST:$PGPORT/$PGDATABASE}"

# Locate the PostgreSQL binaries. Covers Apple Silicon Homebrew, Intel Homebrew,
# Linuxbrew and a system install on PATH.
if [ -z "${PGBIN:-}" ]; then
  for candidate in /opt/homebrew/bin /usr/local/bin /home/linuxbrew/.linuxbrew/bin /usr/bin; do
    if [ -x "$candidate/pg_ctl" ]; then
      PGBIN="$candidate"
      break
    fi
  done
fi
export PGBIN="${PGBIN:-}"

# --- API -------------------------------------------------------------------
export PORT="${PORT:-8787}"
export HOST="${HOST:-0.0.0.0}"
export JWT_SECRET="${JWT_SECRET:-dev-only-secret-change-me-in-production}"
export NODE_ENV="${NODE_ENV:-development}"

# --- Helpers ---------------------------------------------------------------
pg_start()  { "$PGBIN/pg_ctl" -D "$PGDATA" -l "$(dirname "$PGDATA")/log/pg.log" -o "-p $PGPORT -k "$(dirname "$PGDATA")/sock" -c listen_addresses=127.0.0.1" start; }
pg_stop()   { "$PGBIN/pg_ctl" -D "$PGDATA" stop; }
pg_status() { "$PGBIN/pg_isready" -h "$PGHOST" -p "$PGPORT"; }
api_url()   { echo "http://127.0.0.1:$PORT"; }

# --- Android ---------------------------------------------------------------
# Only needed for building the APK or driving the E2E script. Ignored entirely
# if you are not touching the mobile app.
# export ANDROID_TOOLCHAIN_HOME="/path/to/android-toolchain"
