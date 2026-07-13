-- ── Migration 048: Trust Intelligence Sweep Runs ────────────────────────────
-- Operational Deployment Sprint (ENG-044, 2026-07-13). This table belongs to
-- the DEPLOYMENT/OPERATIONAL layer, not to Trust Intelligence itself: it
-- records one summary row per invocation of the scheduled-sweep deployment
-- entrypoint (backend/trust-intelligence/triggers/run-scheduled-sweep-cli.js).
--
-- It does NOT touch trust_profile_instances, does not read or write any
-- Trust Profile Instance field, and generateTrustProfile()/runScheduledSweep()
-- (ENG-029/ENG-032) have no knowledge this table exists — this closes ENG-043's
-- L-3 finding (Railway log retention is the only record of a sweep's outcome)
-- by giving sweep run history a durable, queryable home, independent of the
-- constitutional Trust Profile persistence layer migration 047 already owns.
--
-- Append-only, same discipline as migration 047's trust_profile_instances:
-- one row per completed (or failed-to-complete) sweep invocation, never
-- updated afterward.

CREATE TABLE IF NOT EXISTS trust_intelligence_sweep_runs (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at              TIMESTAMPTZ NOT NULL,
  completed_at            TIMESTAMPTZ NOT NULL,
  duration_ms             INTEGER     NOT NULL,
  policy_threshold_ms     BIGINT,      -- nullable: a crashed run may fail before a valid threshold was even parsed
  population_total        INTEGER     NOT NULL,
  processed_count         INTEGER     NOT NULL,
  skipped_count           INTEGER     NOT NULL,
  failed_count            INTEGER     NOT NULL,
  failed_organisation_ids TEXT[]      NOT NULL DEFAULT '{}',
  outcome                 TEXT        NOT NULL CHECK (outcome IN ('completed', 'crashed')),
  crash_reason            TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Serves "most recent sweep runs" / "failure rate trend across sweeps"
-- (ENG-042 §9's recommended monitoring metrics), both ORDER BY started_at DESC.
CREATE INDEX IF NOT EXISTS idx_trust_intelligence_sweep_runs_started_at
  ON trust_intelligence_sweep_runs (started_at DESC);
