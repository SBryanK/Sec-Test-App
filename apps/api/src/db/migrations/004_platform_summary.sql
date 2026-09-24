-- Migration 004 — edge/origin identification per probe.
--
-- Stores a compact summary of what was in front of and behind the target, e.g.
-- "Tencent EdgeOne → Tencent COS (cache HIT)". Kept per probe because an
-- engagement can span several edges, and because the fingerprints that produced
-- the conclusion live in response_headers on the same row.
--
-- Note: this is a NEW migration rather than an edit to 003. 003 had already been
-- applied, and an applied migration is never re-run — editing it would have
-- silently done nothing.

ALTER TABLE request_traces ADD COLUMN IF NOT EXISTS platform_summary TEXT;

CREATE INDEX IF NOT EXISTS traces_platform_idx
  ON request_traces (run_id, platform_summary)
  WHERE platform_summary IS NOT NULL;
