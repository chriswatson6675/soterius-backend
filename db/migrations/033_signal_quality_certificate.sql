-- ── Migration 033: Certificate Trust Quality Scores ─────────────────────────
-- Stores the normalised 0–100 Certificate Quality Score (Category D – Signal 2),
-- quality_version = '1.0' (CERTIFICATE-QM-v1.0), produced by
-- backend/observatory/quality/certificate-quality.js from immutable certificate
-- observations (signal_certificate_v1) over the authoritative baseline
-- NOB-CERTIFICATE-001-v2 (the C-6/C-7-corrected re-baseline, SLG-104 — NOT the
-- superseded pre-correction v1, SLG-102).
--
-- SEPARATION OF CONCERNS: observations live in signal_certificate_v1 and remain
-- the pure, score-free record. This table is the DERIVED quality layer — one row
-- per domain per quality run. It never mutates an observation.
-- Mirrors signal_quality_spf/dkim/dmarc/caa/dnssec/mtasts/tls (migrations 026–032).
--
-- ── Score model (CERTIFICATE-QM-v1.0: review SLG-101, correction SLG-103,
--    re-baseline SLG-104, validation SLG-105, variability SLG-106,
--    design SLG-107, calibration SLG-108, falsification SLG-109) ──
--   PRIMARY — strict binary read from tls_verification_result. RFC 5280 §6
--   defines path validation as a boolean determination with no partial-trust
--   state; every non-CHAIN_VERIFIED outcome is hard-failed identically by
--   every major browser/OS trust store, so no ordinal ranking is invented
--   among the failure sub-types (HOSTNAME_MISMATCH, CERT_EXPIRED,
--   CHAIN_UNVERIFIABLE, SELF_SIGNED, SELF_SIGNED_IN_CHAIN, OTHER_TLS_ERROR).
--     CEILING = 100  (CHAIN_VERIFIED — 95.77% of NOB-CERTIFICATE-001-v2)
--     FLOOR   =   0  (every other verification result — 4.23%)
--     unobserved (endpoint_state != RESPONSE_OBSERVED, or certificate_present
--       != CERTIFICATE_PRESENTED) → NOT SCORED — NO ROW is emitted
--       (Unknown ≠ Absent)
--
--   leaf_is_self_signed is NOT a scoring input — every self-signed domain
--   already floors under Primary regardless of its specific
--   tls_verification_result label (proven by cross-tab, SLG-106); a
--   standalone multiplier on it would be arithmetically inert. It is
--   surfaced only in evidence_flags/evidence for diagnostic reporting.
--
--   SECONDARY — three reduce-only multipliers, applied ONLY when primary=100:
--     M1 Key Strength    = 0.50 if RSA<2048 bits, else 1.00 (resolves
--                          RSA-vs-EC: no cross-family ranking, NIST SP 800-57
--                          / CA/Browser Forum BR §6.1.5 parity at standard
--                          sizes; currently 0% national population effect,
--                          retained as a calibrated-but-inert safeguard)
--     M2 Wildcard        = 0.95 if leaf_is_wildcard=true, else 1.00
--                          (28.75% population effect)
--     M3 Lifetime        = 0.95 if leaf_lifetime_days>100, else 1.00
--                          (resolves the lifetime question per the CA/Browser
--                          Forum's own direction toward shorter max validity;
--                          100-day threshold is a Stage-6 recalibration from
--                          Phase 5's 398-day design sketch — zero
--                          CHAIN_VERIFIED certs exceed 398 days by
--                          construction; 22.17% population effect)
--   M4 (AIA/OCSP-URL presence) was REMOVED at calibration (SLG-108 §6): its
--   absence rate was 90.8% attributable to Let's Encrypt's documented OCSP-
--   sunset policy alone — near-perfectly collinear with CA identity, which
--   this model excludes from scoring on principle. No M4 column exists here.
--
--   cert_chain_complete is NOT a scoring input (SLG-107 §5) — no standard
--   ranks root-inclusion either direction.
--
--   Realised national values (NOB-CERTIFICATE-001-v2): 0, 90.25, 95, 100.
--
-- ── Provenance with run_id (signal_certificate_v1 IS a v1 schema)
-- signal_certificate_v1 already carries a `run_id` column (migration 015) —
-- the quality layer's run_id here identifies the SCORING run, distinct from
-- (but referencing) the collection run_id it was scored from.
--
-- Apply via backend/tooling/db/apply-migration.js (Supabase MCP is read-only for DDL).
-- Idempotent.

CREATE TABLE IF NOT EXISTS signal_quality_certificate (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                TEXT        NOT NULL,

  -- ── Governed run identity ──────────────────────────────────────────────────
  run_id                UUID        NOT NULL,                     -- this scoring run
  run_label             TEXT        NOT NULL,                     -- 'NOB-CERTIFICATE-001-v2'
  source_run_id         UUID        NOT NULL,                     -- signal_certificate_v1.run_id scored from

  quality_version       TEXT        NOT NULL DEFAULT '1.0',       -- CERTIFICATE-QM-v1.0
  signal_version        TEXT        NOT NULL DEFAULT '1.0.0',     -- certificate collector version scored
  collected_at          TIMESTAMPTZ NOT NULL,                     -- observation time of the scored facts

  -- ── Primary state ─────────────────────────────────────────────────────────
  primary_score         INTEGER     NOT NULL,                     -- 100 | 0
  primary_label         TEXT        NOT NULL,                     -- CEILING | FLOOR

  -- ── Secondary multipliers (NULL when primary=0 — never evaluated) ─────────
  m1_key_strength       NUMERIC,                                  -- 1.00 | 0.50
  m2_wildcard           NUMERIC,                                  -- 1.00 | 0.95
  m3_lifetime           NUMERIC,                                  -- 1.00 | 0.95

  -- ── Final normalised quality score (0–100) ─────────────────────────────────
  final_score           NUMERIC     NOT NULL,

  -- Diagnostic annotation, never applied to final_score (SLG-107 §2):
  -- surfaces self-signed status even when tls_verification_result masks it
  -- as CERT_EXPIRED. Also carries the raw verification result and key facts.
  evidence              JSONB       NOT NULL DEFAULT '{}'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_quality_certificate_final_range   CHECK (final_score >= 0 AND final_score <= 100),
  CONSTRAINT signal_quality_certificate_primary_range CHECK (primary_score IN (0, 100)),
  CONSTRAINT signal_quality_certificate_primary_label CHECK (primary_label IN ('FLOOR','CEILING')),
  -- A floored domain has no multipliers evaluated (arithmetically moot — 0 × anything = 0).
  CONSTRAINT signal_quality_certificate_floor_no_multipliers CHECK (
    primary_score != 0 OR (m1_key_strength IS NULL AND m2_wildcard IS NULL AND m3_lifetime IS NULL)
  ),
  -- A ceiling domain must have all three multipliers evaluated.
  CONSTRAINT signal_quality_certificate_ceiling_has_multipliers CHECK (
    primary_score != 100 OR (m1_key_strength IS NOT NULL AND m2_wildcard IS NOT NULL AND m3_lifetime IS NOT NULL)
  ),
  CONSTRAINT signal_quality_certificate_m1_range CHECK (m1_key_strength IS NULL OR m1_key_strength IN (0.50, 1.00)),
  CONSTRAINT signal_quality_certificate_m2_range CHECK (m2_wildcard IS NULL OR m2_wildcard IN (0.95, 1.00)),
  CONSTRAINT signal_quality_certificate_m3_range CHECK (m3_lifetime IS NULL OR m3_lifetime IN (0.95, 1.00)),
  -- Ordinal/arithmetic preservation: final_score = primary_score × M1 × M2 × M3
  -- (with a floor domain's final_score simply equal to primary_score = 0).
  CONSTRAINT signal_quality_certificate_final_consistent CHECK (
    (primary_score = 0 AND final_score = 0)
    OR (primary_score = 100 AND final_score = ROUND(100 * m1_key_strength * m2_wildcard * m3_lifetime, 2))
  ),
  -- One score per domain per scoring run.
  CONSTRAINT signal_quality_certificate_run_domain_unique UNIQUE (run_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_certificate_domain    ON signal_quality_certificate (domain);
CREATE INDEX IF NOT EXISTS idx_signal_quality_certificate_run       ON signal_quality_certificate (run_id);
CREATE INDEX IF NOT EXISTS idx_signal_quality_certificate_run_label ON signal_quality_certificate (run_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_certificate_final     ON signal_quality_certificate (final_score);
CREATE INDEX IF NOT EXISTS idx_signal_quality_certificate_primary   ON signal_quality_certificate (primary_label);
