-- ── Migration 038: Collection Programmes & Collection Runs ──────────────────
--
-- Sprint 5 of the ADR-SYS-009 implementation programme. Implements the two
-- OPERATIONAL objects OBS-CONST-001 §3 defines as the ownership chain above an
-- Observation, and which the Canonical Observation Contract (Sprint 4) requires
-- to exist before Observation persistence can carry a meaningful
-- collection_programme_id / collection_run_id:
--
--   Collection Programme  — "the Observatory's standing commitment to observe a
--                            given population for a given signal, on an ongoing
--                            basis" (OBS-CONST-001 §3). Comprises many Runs.
--   Collection Run        — "one execution of a Collection Programme — the unit
--                            at which a population is observed" (§3). Produces
--                            Observations (in a later sprint; NOT here).
--
-- SCOPE: minimum persistent IDENTITY and LIFECYCLE only. No orchestration, no
-- scheduling, no dashboards, no Observation table. This migration gives future
-- Observations a stable owner to reference; it does not run anything.
--
-- CONSTITUTIONAL CONFORMANCE:
--   * These are OPERATIONAL objects, not Observations or Events — so their
--     current-state lifecycle (a run moving RUNNING → COMPLETED) is legitimately
--     mutable. P-3 immutability binds Observations and Events (evidence/history),
--     NOT the operational commissioning objects that produce them. What IS
--     immutable here is IDENTITY: collection_runs.id and its programme_id /
--     run_label / started_at never change once written (enforced at the
--     data-access layer, backend/observatory/collection/registry.js — the
--     lifecycle functions only ever touch status / completed_at / metadata).
--   * §5 invariant "no single object spans layers": these tables hold operational
--     state ONLY. They store no evidence, no score, and no organisation-identity
--     decision.
--   * Engineering-Validation carve-out (Sprint 1 finding): a validation run tests
--     collector code, not organisational truth. Its Observations must never reach
--     Organisation History (a P-1 violation). contributes_to_history = FALSE marks
--     that at the programme level so the future Observation→History projection can
--     hard-exclude it by construction, never by ad-hoc filtering.
--
-- Apply via backend/tooling/db/apply-migration.js (Supabase MCP is read-only for
-- DDL). Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING).

-- -----------------------------------------------------------------------------
-- Table: collection_programmes  (standing Observatory programmes)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collection_programmes (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable natural identity: a slug that never changes for the life of the
  -- programme (e.g. 'national-tls'). UNIQUE makes programme creation idempotent.
  programme_key          TEXT        NOT NULL UNIQUE,

  name                   TEXT        NOT NULL,

  -- The class of programme. Drives whether/how its Observations flow downstream.
  kind                   TEXT        NOT NULL,

  -- Single-signal programmes name their signal (e.g. 'tls'); cross-cutting
  -- programmes (Public Scan runs 5 legacy signals; Engineering Validation, Retry,
  -- Residual span signals) leave it NULL. NULL means "not signal-scoped", never
  -- "unknown signal".
  signal                 TEXT,

  description            TEXT,

  -- Whether Observations produced under this programme contribute to Organisation
  -- History. FALSE for Engineering Validation (see header). Programme-level, so a
  -- run can never accidentally opt its observations in.
  contributes_to_history BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Programme lifecycle. A programme is a standing commitment; it is paused or
  -- retired, never deleted (retiring preserves the ownership of its historical
  -- runs).
  status                 TEXT        NOT NULL DEFAULT 'ACTIVE',

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT collection_programmes_kind_values
    CHECK (kind IN ('NATIONAL','PUBLIC_SCAN','ENGINEERING_VALIDATION','RETRY','RESIDUAL','TARGETED')),
  CONSTRAINT collection_programmes_status_values
    CHECK (status IN ('ACTIVE','PAUSED','RETIRED'))
);

-- -----------------------------------------------------------------------------
-- Table: collection_runs  (one execution commissioned by a programme)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collection_runs (
  -- Immutable identity. This is the id a future Observation references as its
  -- collection_run_id; it is assigned once and never changes.
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ownership: every run belongs to exactly one programme. A programme owns many
  -- runs (one-to-many). RESTRICT — a programme with runs cannot be deleted out
  -- from under them (identity stability).
  programme_id           UUID        NOT NULL REFERENCES collection_programmes(id) ON DELETE RESTRICT,

  -- Human/governance label for this execution (e.g. 'NOB-TLS-001'). Part of
  -- identity — immutable once set.
  run_label              TEXT        NOT NULL,

  -- Run lifecycle. Mutable operational state (NOT evidence): a run is opened
  -- RUNNING (or staged PENDING) and reaches exactly one terminal state.
  status                 TEXT        NOT NULL DEFAULT 'RUNNING',

  -- Identity timing: when the run began. Immutable.
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set once, on the terminal transition. NULL while non-terminal.
  completed_at           TIMESTAMPTZ,

  -- Minimal free-form operational metadata (population size, cohort label, etc.).
  -- NOT a place for evidence, scores, or per-domain results.
  metadata               JSONB       NOT NULL DEFAULT '{}'::jsonb,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT collection_runs_status_values
    CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','ABANDONED')),
  CONSTRAINT collection_runs_completed_after_started
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_collection_runs_programme
  ON collection_runs (programme_id);

CREATE INDEX IF NOT EXISTS idx_collection_runs_programme_started
  ON collection_runs (programme_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_collection_runs_status
  ON collection_runs (status);

-- -----------------------------------------------------------------------------
-- Seed: the standing programmes named in the Sprint 5 brief. ON CONFLICT DO
-- NOTHING keeps this idempotent and never overwrites a programme once it exists.
-- Additional programmes (one NATIONAL per signal, TARGETED cohorts) are created
-- through the data-access layer under the same programme_key discipline; only
-- the brief's examples are seeded here to stay minimal.
-- -----------------------------------------------------------------------------

INSERT INTO collection_programmes (programme_key, name, kind, signal, description, contributes_to_history)
VALUES
  ('national-security-headers', 'National Security Headers', 'NATIONAL', 'securityheaders',
   'Standing national collection of the HTTP Security Headers signal.', TRUE),
  ('national-tls', 'National TLS', 'NATIONAL', 'tls',
   'Standing national collection of the TLS signal.', TRUE),
  ('public-scan', 'Public Scan', 'PUBLIC_SCAN', NULL,
   'The public-facing scan funnel (legacy scanner), re-cast as a Collection Programme per ADR-SYS-009. Population is visitor-submitted, not Repository-Authority-selected.', TRUE),
  ('engineering-validation', 'Engineering Validation', 'ENGINEERING_VALIDATION', NULL,
   'Collector code-correctness validation runs. Observations here NEVER contribute to Organisation History.', FALSE),
  ('retry-collection', 'Retry Collection', 'RETRY', NULL,
   'Re-collection of domains a prior run failed to observe.', TRUE),
  ('residual-collection', 'Residual Collection', 'RESIDUAL', NULL,
   'Collection of the residual population a prior programme did not resolve.', TRUE)
ON CONFLICT (programme_key) DO NOTHING;
