-- ── Migration 029: CAA Trust Quality Scores ─────────────────────────────────
-- Stores the normalised 0–100 CAA Quality Score (Category B – Signal 1),
-- quality_version = 'CAA-QM-v1.0', produced by
-- backend/observatory/quality/caa-quality.js from immutable CAA observations
-- (signal_facts_caa) over the authoritative baseline NOB-CAA-001R.
--
-- SEPARATION OF CONCERNS: observations live in signal_facts_caa and remain the pure,
-- score-free record. This table is the DERIVED quality layer — one row per organisation
-- per quality run. It never mutates an observation.
-- Mirrors signal_quality_spf (026) / signal_quality_dkim (027) / signal_quality_dmarc (028).
--
-- ── Score model (CAA-QM-v1.0: design SLG-070, calibration SLG-071) ───────────
--   PRIMARY — scope of certificate issuance the Relevant RRset constrains. RFC 8659 §4.3
--     partitions every request into exactly two disjoint classes (wildcard / non-wildcard):
--       RESTRICTED     = 100  (2 of 2 — an `issue` Property with >=1 authorising issuer)
--       WILDCARD_ONLY  =  50  (1 of 2 — `issuewild` only; §4.3 leaves non-wildcard free)
--       UNCONSTRAINED  =   0  (0 of 2 — no RRset, or no `issue`/`issuewild` Property;
--                              §4.2 "CAA does not restrict issuance"). A CONFIRMED floor.
--       PROHIBITED     = UNCALIBRATED (n = 0 nationally) — NO ROW is ever emitted.
--       unobserved     = NOT SCORED — NO ROW is emitted (SLG-043 P1).
--   MULTIPLIERS (reduce-only, multiplicative):
--       M1 wildcard authorisation exceeds base  ×0.90   (§4.3)
--       M2 inoperative published element        ×0.95   (§4.2 / §4.5 / §4.4 / §4.1)
--       M3 critical flag on unrecognised tag    UNCALIBRATED — flagged only (SLG-072 CR-4)
--   Realised values: 0, 50, 85.5, 90, 95, 100.
--
-- ── CR-5 (SLG-072): provenance without run_id ────────────────────────────────
-- signal_facts_caa is a v0 schema with NO run_id column (SLG-066 G1), so the quality layer
-- defines its own governed run identifier (deterministic from run_label, as DKIM/DMARC do)
-- AND records the baseline window + observations SHA-256 that fix the evidence exactly.
--
-- ── CR-2 (SLG-072): the model is peer-independent but NOT row-independent ────
-- RFC 8659 §3's tree climb means an absent domain whose in-population ancestor publishes CAA
-- is governed by the ancestor's RRset. `record_source` / `inherited_from` record that.
--
-- Apply via Supabase Dashboard → SQL Editor (or the Management API). Idempotent.

CREATE TABLE IF NOT EXISTS signal_quality_caa (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                TEXT        NOT NULL,

  -- ── Governed run identity (CR-5) ───────────────────────────────────────────
  run_id                UUID        NOT NULL,                     -- deterministic from run_label
  run_label             TEXT        NOT NULL,                     -- 'NOB-CAA-001R'
  baseline_sha256       TEXT        NOT NULL,                     -- observations.ndjson SHA-256
  baseline_window_start TIMESTAMPTZ NOT NULL,                     -- collected_at window (G1)
  baseline_window_end   TIMESTAMPTZ NOT NULL,

  quality_version       TEXT        NOT NULL DEFAULT 'CAA-QM-v1.0',
  signal_version        INTEGER     NOT NULL DEFAULT 1,           -- caa collector version scored
  collected_at          TIMESTAMPTZ NOT NULL,                     -- observation time of the scored facts

  -- ── Primary state ─────────────────────────────────────────────────────────
  primary_score         INTEGER     NOT NULL,                     -- 100 | 50 | 0
  primary_label         TEXT        NOT NULL,                     -- RESTRICTED | WILDCARD_ONLY | UNCONSTRAINED

  -- ── R4 inheritance provenance (CR-2) ──────────────────────────────────────
  record_source         TEXT        NOT NULL,                     -- 'self' | 'ancestor' | 'none'
  inherited_from        TEXT,                                     -- the governing ancestor, when 'ancestor'

  -- ── Final normalised quality score (0–100, after reduce-only multipliers) ─
  final_score           NUMERIC     NOT NULL,

  -- Which multipliers fired: [{"name":"...","factor":0.90}, ...]
  multipliers_applied   JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- ── Uncalibrated conditions, evaluated and recorded, never applied (CR-4) ──
  m3_critical_unrecognised BOOLEAN  NOT NULL DEFAULT FALSE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_quality_caa_final_range   CHECK (final_score >= 0 AND final_score <= 100),
  CONSTRAINT signal_quality_caa_primary_range CHECK (primary_score IN (0, 50, 100)),
  CONSTRAINT signal_quality_caa_primary_label CHECK (primary_label IN ('RESTRICTED','WILDCARD_ONLY','UNCONSTRAINED')),
  CONSTRAINT signal_quality_caa_record_source CHECK (record_source IN ('self','ancestor','none')),
  -- Ordinal preservation (SLG-071 §4.1): bands are disjoint and non-inverting.
  -- Max total reduction is 0.90 × 0.95 = 0.855, so no score can cross a band boundary.
  CONSTRAINT signal_quality_caa_bands CHECK (
       (primary_score = 100 AND final_score >= 85.5 AND final_score <= 100)
    OR (primary_score =  50 AND final_score >= 47.5 AND final_score <=  50)
    OR (primary_score =   0 AND final_score =  0)
  ),
  -- An inherited RRset must name its ancestor; a self/none source must not.
  CONSTRAINT signal_quality_caa_inheritance CHECK (
    (record_source = 'ancestor' AND inherited_from IS NOT NULL)
    OR (record_source <> 'ancestor' AND inherited_from IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_caa_domain    ON signal_quality_caa (domain);
CREATE INDEX IF NOT EXISTS idx_signal_quality_caa_run       ON signal_quality_caa (run_id);
CREATE INDEX IF NOT EXISTS idx_signal_quality_caa_run_label ON signal_quality_caa (run_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_caa_final     ON signal_quality_caa (final_score);
CREATE INDEX IF NOT EXISTS idx_signal_quality_caa_primary   ON signal_quality_caa (primary_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_caa_inherited ON signal_quality_caa (inherited_from) WHERE inherited_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signal_quality_caa_m3        ON signal_quality_caa (m3_critical_unrecognised) WHERE m3_critical_unrecognised;
