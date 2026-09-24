-- Migration 003 — connection detail and attack iteration.
--
-- remote_address: the resolved IP and port that answered, equivalent to the
-- "Remote address" line in a browser's network panel. For a CDN-fronted target
-- this names the edge node that served the request, which is often the whole
-- point of the test.
--
-- iteration: the 1-based attempt number within one test.
--   * Load tests (spike, flood) — the request number. Lets a run answer
--     "at which request did the target start blocking me?"
--   * Payload tests (SQLi, XSS, traversal, brute force) — which payload in the
--     dictionary produced this result.
-- Without it, a 500-request run is an undifferentiated pile of rows.

ALTER TABLE request_traces ADD COLUMN IF NOT EXISTS iteration INTEGER;
ALTER TABLE request_traces ADD COLUMN IF NOT EXISTS remote_address TEXT;

-- Backfill existing rows: sequence number is the best available proxy.
UPDATE request_traces SET iteration = seq WHERE iteration IS NULL;

CREATE INDEX IF NOT EXISTS traces_run_iteration_idx ON request_traces (run_id, iteration);
