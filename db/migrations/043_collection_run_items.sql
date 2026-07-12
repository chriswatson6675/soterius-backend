-- ── Migration 043: Collection Run Items (crash-safe resume ledger) ───────────
--
-- Production-hardening sprint, Blocker 4 (Restart / Resume) + Blocker 2 (retry
-- metadata). Records, per Collection Run, the collection state of each intended
-- organisation. This is the durable execution progress that makes a national run
-- resumable and idempotent: a restarted run reads this ledger, skips every
-- organisation already COMPLETED, and re-collects only the outstanding ones.
--
-- CONSTITUTIONAL POSITION — this is an OPERATIONAL object, the same class as
-- collection_runs (migration 038). It holds execution bookkeeping and retry
-- metadata ONLY: no score, no signal fact, no organisation-identity decision. It
-- is mutable precisely because it is NOT evidence. Observations and Events remain
-- immutable and are never touched by resume. observation_id is a POINTER to the
-- evidence a completed item produced (so resume can prove completeness) — never a
-- copy of it.
--
-- The UNIQUE (collection_run_id, domain) constraint is the idempotency key: one
-- ledger row per organisation per run, so re-initialising a resumed run can never
-- duplicate an item, and "already collected" is a single-row lookup.
--
-- Apply via backend/tooling/db/apply-migration.js --confirm. Idempotent.

CREATE TABLE IF NOT EXISTS collection_run_items (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The run this item belongs to. CASCADE: an item has no meaning without its run
  -- (unlike Observations, which are permanent evidence and never cascade-deleted).
  collection_run_id  UUID        NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,

  -- The organisation being collected, by domain (the unit the national runner
  -- iterates). Resolution to a canonical ORG-* id happens in the Observation, not
  -- here — the ledger is deliberately identity-decision-free.
  domain             TEXT        NOT NULL,

  -- Item lifecycle:
  --   PENDING   — not yet attempted
  --   RUNNING   — an attempt is in flight
  --   COMPLETED — Observation written (see observation_id)
  --   FAILED    — transient/unexpected failure; eligible for re-collection on resume
  --   PERMANENT — definite failure (NXDOMAIN, malformed, unsupported protocol);
  --               will not recover, excluded from resume
  status             TEXT        NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','PERMANENT')),

  -- Retry metadata (Blocker 2) — persisted WITHOUT touching the Observation.
  attempts           INTEGER     NOT NULL DEFAULT 0,
  last_failure_class TEXT        CHECK (last_failure_class IN ('RETRYABLE','PERMANENT','UNEXPECTED') OR last_failure_class IS NULL),
  last_error         TEXT,

  -- Pointer to the Observation a COMPLETED item produced. NULL until completed.
  observation_id     UUID,

  first_attempted_at TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT collection_run_items_unique_per_run UNIQUE (collection_run_id, domain)
);

-- Resume work-list query: outstanding items for a run (status not COMPLETED /
-- PERMANENT). Partial index keeps it small even at national scale.
CREATE INDEX IF NOT EXISTS idx_collection_run_items_outstanding
  ON collection_run_items (collection_run_id)
  WHERE status IN ('PENDING','RUNNING','FAILED');

CREATE INDEX IF NOT EXISTS idx_collection_run_items_run_status
  ON collection_run_items (collection_run_id, status);
