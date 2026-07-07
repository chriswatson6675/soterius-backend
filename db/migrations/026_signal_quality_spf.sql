-- ── Migration 026: SPF Trust Quality Scores ─────────────────────────────────
-- Stores the normalised 0–100 SPF Quality Score (Category A – Signal 1),
-- quality_version = 1.0, produced by backend/observatory/quality/spf-quality.js
-- from immutable SPF observations (signal_facts_spf).
--
-- SEPARATION OF CONCERNS: observations live in signal_facts_spf and remain the
-- pure, score-free record. This table is the DERIVED quality layer — one row per
-- organisation per quality run. It never mutates an observation.
--
-- Score model (frozen, SPF calibration — see SLG-044):
--   Primary: -all=100 · ~all=90 · ?all=60 · Missing all=40 · +all=5 · Absent=0
--            Unknown → not scored (no row is emitted for Observation Incomplete).
--   Multipliers (multiplicative): Multiple records / Invalid version / Unknown
--            mechanism / Malformed include / Malformed IP / Invalid IP = ×0.00;
--            Duplicate all ×0.95 · All not last ×0.90 · Near lookup limit ×0.95.
--   "Missing all" is primary-only (40); it is NOT a multiplier.
--
-- run_id ties every row to a governed run (e.g. NOB-001R) recorded in SLG-003.
--
-- Apply via Supabase Dashboard → SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS signal_quality_spf (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain               TEXT        NOT NULL,
  run_id               UUID        NOT NULL,
  run_label            TEXT,                      -- e.g. 'NOB-001R'
  quality_version      TEXT        NOT NULL DEFAULT '1.0',
  signal_version       INTEGER     NOT NULL DEFAULT 1,   -- SPF collector version scored
  collected_at         TIMESTAMPTZ NOT NULL,            -- observation time of the scored facts

  -- Primary state (enforcement disposition)
  primary_score        INTEGER     NOT NULL,   -- 100|90|60|40|5|0
  primary_label        TEXT        NOT NULL,   -- '-all'|'~all'|'?all'|'Missing all'|'+all'|'Absent'

  -- Final normalised quality score (0–100, after multipliers)
  final_score          NUMERIC     NOT NULL,

  -- Which multipliers fired: [{"name":"...","factor":0.95}, ...]
  multipliers_applied  JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- True when a ×0.00 (fatal) multiplier reduced a PRESENT record to zero
  fatal                BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_quality_spf_final_range CHECK (final_score >= 0 AND final_score <= 100),
  CONSTRAINT signal_quality_spf_primary_range CHECK (primary_score IN (0, 5, 40, 60, 90, 100))
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_spf_domain      ON signal_quality_spf (domain);
CREATE INDEX IF NOT EXISTS idx_signal_quality_spf_run         ON signal_quality_spf (run_id);
CREATE INDEX IF NOT EXISTS idx_signal_quality_spf_run_label   ON signal_quality_spf (run_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_spf_final       ON signal_quality_spf (final_score);
CREATE INDEX IF NOT EXISTS idx_signal_quality_spf_primary     ON signal_quality_spf (primary_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_spf_fatal       ON signal_quality_spf (fatal) WHERE fatal IS TRUE;
