-- ── Migration 052: Observation State Foundation (OBS-101) ───────────────────
--
-- WP-1 of the Observation Platform implementation programme. Creates
-- observation_states: the one new, deliberately MUTABLE table in the frozen
-- Observation Domain Architecture (Organisation → Observation Definition →
-- Observation State → Evidence → Trust Profile). This table holds ONLY the
-- schedulable, per-Organisation tracking state — not evidence, not a score.
--
-- NOT a violation of OBS-CONST-001's immutability principle: that principle
-- governs OBS-CONST-001's own constitutional object named "Observation" (the
-- immutable persisted fact — what this programme's vocabulary calls
-- Evidence). "Observation State" is a distinct, newly-adopted term for a
-- different object: the current-state pointer that tracks when an
-- Organisation's evidence for a given Observation Definition was last
-- confirmed and when it is next due. It is the one object in this model
-- expected to mutate in place — see updated_at.
--
-- OBS-101 scope: schema + domain contract only. This table is not yet read
-- or written by any existing code path (generate-trust-profile.js,
-- scheduled-regeneration.js, or any route) — see
-- backend/observatory/observation-state/no-consumers.structural.test.js.
--
-- organisation_id is TEXT, matching the canonical ORG-<hash> identity scheme
-- fixed by migration 041 (ADR-SYS-010 OC-6) — not UUID.

CREATE TABLE IF NOT EXISTS observation_states (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id       TEXT        NOT NULL,
  observation_type      TEXT        NOT NULL,
  collection_group      TEXT        NOT NULL,
  last_observed_at      TIMESTAMPTZ,
  next_due_at           TIMESTAMPTZ,
  status                TEXT        NOT NULL DEFAULT 'never_observed'
                          CHECK (status IN ('never_observed', 'due', 'running', 'observed', 'failed', 'suspended')),
  collector_version     TEXT,
  evidence_ref          TEXT,
  provenance_ref        TEXT,
  material_change       TEXT,
  attempt_count         INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_failure_at       TIMESTAMPTZ,
  last_failure_reason   TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_observation_states_org_type UNIQUE (organisation_id, observation_type)
);

-- Serves the future due-selection query (WP-4, not implemented by this
-- migration): partial index, since a 'running' row is never a due-selection
-- candidate.
CREATE INDEX IF NOT EXISTS idx_observation_states_next_due_at
  ON observation_states (next_due_at)
  WHERE status <> 'running';
