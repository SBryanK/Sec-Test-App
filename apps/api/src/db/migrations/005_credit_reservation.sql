-- --------------------------------------------------------------------------
-- 005: make credit charging reservation-based and idempotent.
--
-- Before this migration a run's cost was checked with a plain SELECT at submit
-- time and only debited when the run finished. Two consequences:
--
--   * Two concurrent submissions both read the same balance and both passed,
--     so the account could go negative (the check and the debit were not in the
--     same transaction and not against the same locked row).
--   * A run that never finished — cancelled, crashed, or rejected because the
--     queue was full — was never debited at all, so heavy users could simply
--     abandon runs to avoid the cost.
--
-- The cost is now reserved at submit time inside the same transaction that
-- reads the balance, and settled against the tests that actually executed when
-- the run ends. This partial unique index is what makes settlement idempotent:
-- a retried or duplicated finish cannot charge the same run twice.
-- --------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS ledger_run_charge_uniq
  ON credit_ledger (run_id)
  WHERE run_id IS NOT NULL AND reason = 'run';

-- Refunds and top-ups for a run are separate rows, so they are intentionally
-- not covered by the index above.
CREATE INDEX IF NOT EXISTS ledger_run_idx ON credit_ledger (run_id);

-- --------------------------------------------------------------------------
-- Top-up requests get a real table.
--
-- They used to be encoded as a `delta = 0` row in `credit_ledger` with a
-- `credit-request:<uuid>` reason. That put a non-movement into an accounting
-- table, and nothing anywhere listed those rows — so "an administrator will
-- approve it" was a promise the API could not keep: there was no endpoint to
-- grant credits to anybody. Requests now have their own lifecycle, and the
-- admin endpoints to read and grant them live alongside this table.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credit_requests (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note         TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS credit_requests_pending_idx
  ON credit_requests (requested_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS credit_requests_user_idx
  ON credit_requests (user_id, requested_at DESC);

-- Carry across any request previously recorded as a ledger marker, so an
-- operator who asked for credits before this migration is not silently dropped
-- from the queue. `reason` was `credit-request:<uuid>`; the uuid is reused as
-- the request id.
INSERT INTO credit_requests (id, user_id, note, requested_at)
SELECT (split_part(reason, ':', 2))::uuid, user_id, 'Imported from credit_ledger marker', created_at
  FROM credit_ledger
 WHERE reason LIKE 'credit-request:%'
   AND split_part(reason, ':', 2) ~ '^[0-9a-fA-F-]{36}$'
ON CONFLICT (id) DO NOTHING;

-- Those rows are not credit movements and never were; drop them so the ledger
-- is purely a record of balance changes.
DELETE FROM credit_ledger WHERE reason LIKE 'credit-request:%';
