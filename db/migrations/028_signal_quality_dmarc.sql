-- ── Migration 028: DMARC Trust Quality Scores ───────────────────────────────
-- Stores the normalised 0–100 DMARC Quality Score (Category A – Signal 3),
-- quality_version = 1.0 (DMARC-QM-v1.0), produced by
-- backend/observatory/quality/dmarc-quality.js from immutable DMARC observations
-- (signal_facts_dmarc).
--
-- SEPARATION OF CONCERNS: observations live in signal_facts_dmarc and remain the
-- pure, score-free record. This table is the DERIVED quality layer — one row per
-- organisation per quality run. It never mutates an observation.
-- Mirrors signal_quality_spf (mig 026) and signal_quality_dkim (mig 027).
--
-- Score model (DMARC-QM-v1.0, see SLG-059 design / SLG-060 calibration):
--   Primary (enforcement disposition p=): reject=100 · quarantine=75 · none=40 ·
--     no-usable-policy=0 (absent | multiple records [RFC 7489 §6.6.3] | missing/invalid p).
--     Unknown (DNS failure) → NOT scored (no row emitted).
--   Multipliers (reduce-only, multiplicative):
--     M1 pct<100 ×0.90 · M2 sp weaker than p ×0.90 · M3 malformed-with-valid-p ×0.95.
--   No ×0.00 (fatal) multiplier — un-usable-policy is the 0 floor via the primary.
--
-- run_id ties every row to the governed baseline (NOB-DMARC-001).
--
-- Apply via Supabase Dashboard → SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS signal_quality_dmarc (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain               TEXT        NOT NULL,
  run_id               UUID        NOT NULL,
  run_label            TEXT,                      -- e.g. 'NOB-DMARC-001'
  quality_version      TEXT        NOT NULL DEFAULT '1.0',   -- DMARC-QM-v1.0
  signal_version       INTEGER     NOT NULL DEFAULT 1,       -- dmarc collector version scored
  collected_at         TIMESTAMPTZ NOT NULL,                -- observation time of the scored facts

  -- Primary state (enforcement disposition)
  primary_score        INTEGER     NOT NULL,   -- 100|75|40|0
  primary_label        TEXT        NOT NULL,   -- 'reject'|'quarantine'|'none'|'absent'|'no usable policy (...)'
  dmarc_policy         TEXT,                   -- the observed p= value scored (null when floor/no-policy)

  -- Final normalised quality score (0–100, after reduce-only multipliers)
  final_score          NUMERIC     NOT NULL,

  -- Which multipliers fired: [{"name":"...","factor":0.90}, ...]
  multipliers_applied  JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_quality_dmarc_final_range   CHECK (final_score >= 0 AND final_score <= 100),
  CONSTRAINT signal_quality_dmarc_primary_range CHECK (primary_score IN (0, 40, 75, 100)),
  CONSTRAINT signal_quality_dmarc_policy_values CHECK (dmarc_policy IN ('none','quarantine','reject') OR dmarc_policy IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_dmarc_domain    ON signal_quality_dmarc (domain);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dmarc_run       ON signal_quality_dmarc (run_id);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dmarc_run_label ON signal_quality_dmarc (run_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dmarc_final     ON signal_quality_dmarc (final_score);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dmarc_primary   ON signal_quality_dmarc (primary_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dmarc_policy    ON signal_quality_dmarc (dmarc_policy) WHERE dmarc_policy IS NOT NULL;
