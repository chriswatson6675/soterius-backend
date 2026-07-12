-- 039_observation_sessions.sql
--
-- Observation Session — the stateful execution lifecycle over the existing
-- immutable run concept. Approved refinement to the Public Scanner programme;
-- NOT a constitutional abstraction and NOT customer-facing. It lives entirely
-- inside the Observation layer of Reality -> Observations -> Organisation ->
-- Experiences (ADR-SYS-010 is unchanged).
--
-- Model:  Trigger -> Observation Session -> Run -> Observations -> Organisation -> Experiences
--
-- A session owns a run (run_id/run_label — the same identifiers observations
-- already carry). run_label is UNIQUE here, which is how "every Run belongs to
-- exactly one Observation Session" is enforced WITHOUT touching the immutable
-- signal_quality_* / signal_facts_* tables: a run_label may be minted by at
-- most one session. Observations are unchanged — they keep run_id/run_label
-- exactly as today and gain no session reference.
--
-- v1 is intentionally minimal: session creation, lifecycle state, run linkage,
-- execution metadata, an append-only event trail (auditing), and queryable
-- status (monitoring). NO queue, worker, or scheduler is built here — those
-- layer onto this record later without redesign.

CREATE TABLE IF NOT EXISTS observation_sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- How the session was triggered. 'batch' | 'on-demand' | 'scheduled' today;
  -- extensible (e.g. 'event') by adding to the app-level trigger allow-list —
  -- deliberately NOT a DB CHECK, so a new trigger needs no migration. Status,
  -- which is safety-critical and fixed, IS constrained below.
  trigger       TEXT        NOT NULL,

  -- Lifecycle state. Fixed set; transitions are validated in the app layer.
  status        TEXT        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','completed','failed','cancelled')),

  -- What is being observed, e.g. {"domains":["example.com"]} or {"cohort":"..."}.
  scope         JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- The run this session owns. Null while queued (no run yet); assigned when the
  -- session produces/adopts its run. UNIQUE run_label = one-session-per-run.
  run_id        UUID,
  run_label     TEXT        UNIQUE,

  -- Free-form execution metadata (requester, signal counts, error detail, …).
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- Append-only lifecycle audit trail: [{from,to,at,note}, …].
  events        JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,             -- set on first transition to 'running'
  ended_at      TIMESTAMPTZ,             -- set on transition to a terminal state
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS observation_sessions_status_idx     ON observation_sessions (status);
CREATE INDEX IF NOT EXISTS observation_sessions_trigger_idx    ON observation_sessions (trigger);
CREATE INDEX IF NOT EXISTS observation_sessions_created_at_idx ON observation_sessions (created_at DESC);
