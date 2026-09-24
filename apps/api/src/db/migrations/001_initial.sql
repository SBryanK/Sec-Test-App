-- Migration 001 — initial schema.
--
-- Every statement is IF NOT EXISTS, so this is safe to apply to a database
-- created before migrations existed.

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'operator'
                 CHECK (role IN ('operator', 'admin')),
  credits_total  INTEGER NOT NULL DEFAULT 100,
  language       TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'zh')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Runs: one row per execution (single test, batch, or custom set).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id            UUID PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('single', 'batch', 'custom')),
  status        TEXT NOT NULL CHECK (status IN ('queued','running','success','failed','cancelled')),
  label         TEXT NOT NULL,
  target        TEXT NOT NULL,
  test_ids      TEXT[] NOT NULL,
  configs       JSONB NOT NULL,
  duration_ms   INTEGER,
  credits_used  INTEGER NOT NULL DEFAULT 0,
  summary       JSONB,
  error         TEXT,
  provenance    JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS runs_user_created_idx ON runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_target_idx       ON runs (lower(target));
CREATE INDEX IF NOT EXISTS runs_status_idx       ON runs (status);
CREATE INDEX IF NOT EXISTS runs_test_ids_idx     ON runs USING GIN (test_ids);

-- --------------------------------------------------------------------------
-- Request traces: the per-request forensic log.
--
-- This is the highest-volume table in the system. At production scale it should
-- be range-partitioned on created_at (see ops/README.md); the indexes below are
-- what the run-detail and evidence views rely on.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_traces (
  id                   BIGSERIAL PRIMARY KEY,
  run_id               UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  config_id            TEXT NOT NULL,
  test_id              TEXT NOT NULL,
  seq                  INTEGER NOT NULL,
  method               TEXT NOT NULL,
  url                  TEXT NOT NULL,

  request_headers      JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_body_preview TEXT,
  request_bytes        BIGINT NOT NULL DEFAULT 0,
  payload              TEXT,
  injection_point      TEXT,

  status_code          INTEGER,
  response_headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_body_preview TEXT,
  response_bytes       BIGINT NOT NULL DEFAULT 0,
  response_hash        TEXT,

  -- timing breakdown, milliseconds; NULL when the phase was never reached
  dns_ms               DOUBLE PRECISION,
  tcp_ms               DOUBLE PRECISION,
  tls_ms               DOUBLE PRECISION,
  ttfb_ms              DOUBLE PRECISION,
  total_ms             DOUBLE PRECISION,

  verdict              TEXT NOT NULL,
  severity             TEXT,
  reason               TEXT,
  signature            TEXT,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS traces_run_seq_idx  ON request_traces (run_id, seq);
CREATE INDEX IF NOT EXISTS traces_run_test_idx ON request_traces (run_id, test_id);
CREATE INDEX IF NOT EXISTS traces_verdict_idx  ON request_traces (run_id, verdict);

-- --------------------------------------------------------------------------
-- Findings: actionable results rolled up from traces.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS findings (
  id           UUID PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  test_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  verdict      TEXT NOT NULL,
  description  TEXT NOT NULL,
  evidence     TEXT NOT NULL,
  remediation  TEXT NOT NULL,
  trace_ids    BIGINT[] NOT NULL DEFAULT '{}',
  refs         TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS findings_run_idx ON findings (run_id);

-- --------------------------------------------------------------------------
-- Credit ledger: every debit/credit is recorded, so "Used 3 / Remaining 97"
-- is always reconcilable rather than a mutable counter.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_ledger (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  run_id      UUID REFERENCES runs(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_user_idx ON credit_ledger (user_id, created_at DESC);

-- --------------------------------------------------------------------------
-- Saved configs (the "Save" action on every config screen).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_configs (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  test_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  config      JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_user_idx ON saved_configs (user_id, updated_at DESC);
