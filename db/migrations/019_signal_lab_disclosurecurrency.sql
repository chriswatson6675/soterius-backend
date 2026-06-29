-- ── Migration 019: Signal Lab — Disclosure Currency Facts Table ──────────────
-- Creates signal_disclosurecurrency_v1 to store observable Disclosure Currency
-- facts collected by the Category H collector (SOT-DISCLOSURECURRENCY-001 / H-SIG-001,
-- signal_version = 1).
--
-- Authority:
--   SOT-DISCLOSURECURRENCY-001 v1.0 — Signal Specification (PLANNED)
--   SLG-026 (Category H foundation) / GATE-H1B (evidence architecture)
--   GATE-H1C (element framework; element DE-PAD-014)
--   EM-H-D1 (located-state classification — enforced by the CHECK constraint below)
--   GATE-H2 (collection & reproducibility architecture)
--   ADR-SYS-001 (evidence-first; no scores/ratings) / ADR-SYS-006 (JSONB evidence block)
--
-- Storage model (GATE-H1B; SLG-014 §Level 5):
--   One row per unique domain per collection run.
--   Domain is the join key (consistent with all existing signal_* tables).
--   Promoted scalar columns for direct SQL; a JSONB evidence block per ADR-SYS-006.
--   No scores, ratings, or interpretations (Signal Lab rule).
--
-- Four-state located_state (EM-H-D1):
--   located            — a privacy disclosure was located and fully retrieved
--   not_located        — no disclosure located (process state; NOT absence-of-currency)
--   retrieval_failure  — disclosure located but retrieval failed (process state)
--   ambiguous          — a candidate was found but the policy could not be confirmed
--
-- Three-state evidence_state (set ONLY when located_state = 'located'):
--   present            — a qualifying currency indicator was observed
--   absent             — disclosure read; no qualifying currency indicator
--   indeterminate      — candidate date/version not objectively attributable, or partial retrieval
--   NULL               — located_state <> 'located' (process states carry no evidence)
--
-- INTEGRITY INVARIANT (EM-H-D1), enforced server-side by evidence_only_when_located:
--   A non-located row can NEVER carry an evidence_state. This makes
--   "retrieval_failure / not_located -> absent" structurally impossible in the database.
--
-- currency_form (set only when evidence_state = 'present'):
--   dated | version_date | version_only
--
-- Reproducibility (GATE-H2): content_observed stores the exact text the detector
--   evaluated (re-derivation source); content_hash is its sha256. Full raw HTML is
--   not stored — content_observed is the post-extraction text the signal observed.
--
-- Apply via Supabase Dashboard -> SQL Editor.
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS signal_disclosurecurrency_v1 (
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
  currency_raw_value   TEXT,
  currency_form        TEXT
                         CHECK (currency_form IN ('dated','version_date','version_only')),

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

CREATE INDEX IF NOT EXISTS idx_disclosurecurrency_run_id ON signal_disclosurecurrency_v1 (run_id);
CREATE INDEX IF NOT EXISTS idx_disclosurecurrency_domain ON signal_disclosurecurrency_v1 (domain);
