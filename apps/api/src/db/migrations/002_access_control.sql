-- Migration 002 — operator access control.
--
-- Access is invitation-only: an operator requests an account, the admin
-- approves it, and only then can they sign in. Previously the only way to add
-- an operator was to edit the database by hand.
--
-- token_version supports revocation. A JWT carries the version it was issued
-- with; bumping the column invalidates every token for that operator
-- immediately. Without this, a long-lived or non-expiring token is
-- unrecoverable once leaked.

ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_status_check
    CHECK (status IN ('pending', 'active', 'suspended'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Who approved whom, for the audit trail.
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS note TEXT;

-- Accounts that predate this migration are already trusted operators.
UPDATE users SET status = 'active' WHERE status IS NULL OR status = '';

CREATE INDEX IF NOT EXISTS users_status_idx ON users (status, requested_at DESC);
