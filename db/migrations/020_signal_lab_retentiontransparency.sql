-- ── Migration 020: Signal Lab — Retention Transparency Facts Table ─────────────
-- Creates signal_retentiontransparency_v1 to store observable Retention Specification
-- facts collected by the Category H collector (SOT-RETENTIONTRANSPARENCY-001 / H-SIG-002,
-- signal_version = 1, element DE-PAD-015).
--
-- Authority:
--   SOT-RETENTIONTRANSPARENCY-001 v1.0 — Signal Specification (Founder Accepted; CANDIDATE)
--   DE-PAD-015 — Retention Specification (Element Specification, Founder Accepted)
--   Founder Constitutional Refinement — `specific_period` is the SOLE Present-qualifying form
--   SLG-026 (Category H foundation) / GATE-H1B (evidence architecture)
--   GATE-H1C (element framework; element DE-PAD-015)
--   EM-H-D1 (located-state classification — enforced by the CHECK constraint below)
--   ADR-SYS-001 (evidence-first; no scores/ratings) / ADR-SYS-006 (JSONB evidence block)
--
-- Storage model (GATE-H1B): one row per unique domain per collection run; domain is the
--   join key (consistent with all signal_* tables, incl. signal_disclosurecurrency_v1).
--   Promoted scalar columns + a JSONB evidence block. No scores, ratings, or interpretations.
--
-- Four-state located_state (EM-H-D1):
--   located            — a privacy disclosure was located and fully retrieved
--   not_located        — no disclosure located (process state; NOT absence-of-retention)
--   retrieval_failure  — disclosure located but retrieval failed (process state)
--   ambiguous          — a candidate was found but the policy could not be confirmed
--
-- Three-state evidence_state (set ONLY when located_state = 'located'):
--   present            — an attributable numeric retention period was observed (specific_period)
--   absent             — disclosure read; only a closed platitude / no retention specificity
--   indeterminate      — criterion-shaped / off-page / vague / non-attributable / partial retrieval
--   NULL               — located_state <> 'located' (process states carry no evidence)
--
-- INTEGRITY INVARIANT (EM-H-D1), enforced server-side by evidence_only_when_located:
--   A non-located row can NEVER carry an evidence_state — "not_located / retrieval_failure ->
--   absent" is structurally impossible in the database.
--
-- retention_form (set only when evidence_state = 'present'):
--   specific_period   — THE ONLY admissible form. The single-value CHECK encodes the Founder
--                       Constitutional Refinement: objective_criterion can never be written.
--
-- Reproducibility (GATE-H2): content_observed stores the exact text the detector evaluated
--   (re-derivation source); content_hash is its sha256.
--
-- Apply via Supabase Dashboard -> SQL Editor. Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS signal_retentiontransparency_v1 (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               UUID        NOT NULL,
  domain               TEXT        NOT NULL,

  signal_version       INTEGER     NOT NULL DEFAULT 1,
  collector_version    TEXT        NOT NULL,
  element_set_version  TEXT        NOT NULL DEFAULT 'pad-v1',
  collected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── Process state (EM-H-D1) ───────────────────────────────────────────────
  located_state        TEXT        NOT NULL
                         CHECK (located_state IN ('located','not_located','retrieval_failure','ambiguous')),

  -- ── Observable evidence (present only when located) ───────────────────────
  evidence_state       TEXT
                         CHECK (evidence_state IN ('present','absent','indeterminate')),
  retention_raw_value  TEXT,
  retention_form       TEXT
                         CHECK (retention_form IN ('specific_period')),

  -- ── Provenance ────────────────────────────────────────────────────────────
  policy_url           TEXT,
  retrieval_method     TEXT
                         CHECK (retrieval_method IN ('static','headless')),
  http_status          INTEGER,
  content_hash         TEXT,
  content_observed     TEXT,

  -- ── ADR-SYS-006 evidence block (self-contained provenance/context) ────────
  evidence             JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- ── INTEGRITY INVARIANT (EM-H-D1) ─────────────────────────────────────────
  CONSTRAINT evidence_only_when_located
    CHECK (located_state = 'located' OR evidence_state IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_retentiontransparency_run_id ON signal_retentiontransparency_v1 (run_id);
CREATE INDEX IF NOT EXISTS idx_retentiontransparency_domain ON signal_retentiontransparency_v1 (domain);
