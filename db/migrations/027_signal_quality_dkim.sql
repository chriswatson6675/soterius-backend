-- ── Migration 027: DKIM Trust Quality Scores ────────────────────────────────
-- Stores the normalised 0–100 DKIM Quality Score (Category A – Signal 2),
-- quality_version = 1.0 (DKIM-QM-v1.0), produced by
-- backend/observatory/quality/dkim-quality.js from immutable DKIM observations
-- (signal_facts_dkim / signal_facts_dkim_keys).
--
-- SEPARATION OF CONCERNS: observations live in signal_facts_dkim(+_keys) and
-- remain the pure, score-free record. This table is the DERIVED quality layer —
-- one row per organisation per quality run. It never mutates an observation.
-- Mirrors signal_quality_spf (migration 026).
--
-- Score model (frozen — DKIM-QM-v1.0, see SLG-052/SLG-053/SLG-054):
--   Primary (strongest USABLE key, RFC 8301 tiers):
--     >=2048=100 · 1024=85 · <1024=40 · no usable key=0 (probe-set-bounded floor).
--     Unobserved (DNS_FAILURE/SERVFAIL/TIMEOUT) → NOT scored (no row emitted).
--   Multipliers (reduce-only, multiplicative):
--     M1 malformed present ×0.95 · M2 live <1024 residual ×0.80 · M3 testing(t=y) ×0.90.
--   DKIM has no ×0.00 (fatal) multiplier — an unusable-only domain is the 0 floor
--   via the primary, not via a multiplier.
--
-- run_id ties every row to the governed baseline (NOB-DKIM-001R).
--
-- Apply via Supabase Dashboard → SQL Editor. Idempotent.

CREATE TABLE IF NOT EXISTS signal_quality_dkim (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain               TEXT        NOT NULL,
  run_id               UUID        NOT NULL,
  run_label            TEXT,                      -- e.g. 'NOB-DKIM-001R'
  quality_version      TEXT        NOT NULL DEFAULT '1.0',   -- DKIM-QM-v1.0
  signal_version       INTEGER     NOT NULL DEFAULT 1,       -- dkim collector version scored
  probe_set_version    INTEGER     NOT NULL DEFAULT 1,       -- dkim probe-set version of the scored facts
  collected_at         TIMESTAMPTZ NOT NULL,                -- observation time of the scored facts

  -- Primary state (strongest usable key, cryptographic strength)
  primary_score        INTEGER     NOT NULL,   -- 100|85|40|0
  primary_label        TEXT        NOT NULL,   -- '>=2048'|'1024'|'<1024'|'no usable key (bounded)'

  -- Strongest usable key modulus (bits); NULL when there is no usable key
  max_key_bits         INTEGER,

  -- Final normalised quality score (0–100, after reduce-only multipliers)
  final_score          NUMERIC     NOT NULL,

  -- Which multipliers fired: [{"name":"...","factor":0.95}, ...]
  multipliers_applied  JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_quality_dkim_final_range   CHECK (final_score >= 0 AND final_score <= 100),
  CONSTRAINT signal_quality_dkim_primary_range CHECK (primary_score IN (0, 40, 85, 100))
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_dkim_domain    ON signal_quality_dkim (domain);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dkim_run       ON signal_quality_dkim (run_id);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dkim_run_label ON signal_quality_dkim (run_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dkim_final     ON signal_quality_dkim (final_score);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dkim_primary   ON signal_quality_dkim (primary_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dkim_bits      ON signal_quality_dkim (max_key_bits) WHERE max_key_bits IS NOT NULL;
