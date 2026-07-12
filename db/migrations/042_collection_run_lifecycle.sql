-- ── Migration 042: Failure-aware Collection Run lifecycle ────────────────────
--
-- Production-hardening sprint, Blocker 3. Extends the collection_runs lifecycle
-- (migration 038) with TRUTHFUL, failure-aware terminal states and completion
-- summary columns. This is an OPERATIONAL change only: it widens the status
-- vocabulary and adds summary telemetry columns. It does NOT touch evidence
-- (Observations / Events remain immutable) and does NOT alter run IDENTITY
-- (id / programme_id / run_label / started_at are still write-once — enforced at
-- the data-access layer, registry.js).
--
-- New states (union with the existing set for backward compatibility):
--   CREATED   — run row minted, not yet queued/started (staged path)
--   QUEUED    — accepted for execution, awaiting a worker (going-forward synonym
--               of the legacy PENDING)
--   PARTIAL   — execution finished but some organisations remain failed after
--               retries (the honest middle outcome)
--   CANCELLED — intentionally stopped (going-forward synonym of legacy ABANDONED)
-- Retained unchanged: PENDING, RUNNING, COMPLETED, FAILED, ABANDONED.
--
-- Apply via backend/tooling/db/apply-migration.js --confirm (Supabase MCP is
-- read-only for DDL). Idempotent.

-- 1 ── Widen the status CHECK constraint to the full union.
ALTER TABLE collection_runs DROP CONSTRAINT IF EXISTS collection_runs_status_values;
ALTER TABLE collection_runs ADD CONSTRAINT collection_runs_status_values
  CHECK (status IN (
    'CREATED','QUEUED','PENDING','RUNNING','PARTIAL','COMPLETED','FAILED','CANCELLED','ABANDONED'
  ));

-- 2 ── Completion-summary columns. Operational telemetry describing HOW a run
--      finished — coverage of its intended population. NULL for runs that predate
--      this migration and for runs still in flight. Never evidence.
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS intended_count  INTEGER;
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS succeeded_count INTEGER;
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS failed_count    INTEGER;
ALTER TABLE collection_runs ADD COLUMN IF NOT EXISTS coverage_pct    NUMERIC(5,2);

-- A run may only claim COMPLETED if it left no failures uncovered. This is the
-- database-level backstop for the truthful-status rule the executor enforces in
-- code (run-lifecycle.deriveTerminalState): if the summary columns are populated,
-- COMPLETED requires failed_count = 0. Runs without summary columns (legacy /
-- pre-migration) are unaffected.
ALTER TABLE collection_runs DROP CONSTRAINT IF EXISTS collection_runs_completed_is_truthful;
ALTER TABLE collection_runs ADD CONSTRAINT collection_runs_completed_is_truthful
  CHECK (
    status <> 'COMPLETED'
    OR failed_count IS NULL
    OR failed_count = 0
  );
