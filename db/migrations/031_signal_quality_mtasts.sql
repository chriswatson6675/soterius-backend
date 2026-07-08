-- ── Migration 031: MTA-STS Trust Quality Scores ─────────────────────────────
-- Stores the normalised 0–100 MTA-STS Quality Score (Category D – Signal 3),
-- quality_version = '1.0' (MTASTS-QM-v1.0), produced by
-- backend/observatory/quality/mtasts-quality.js from immutable MTA-STS observations
-- (signal_facts_mtasts) over the authoritative baseline NOB-MTASTS-001.
--
-- SEPARATION OF CONCERNS: observations live in signal_facts_mtasts and remain the
-- pure, score-free record. This table is the DERIVED quality layer — one row per
-- domain per quality run. It never mutates an observation.
-- Mirrors signal_quality_spf (mig 026) / signal_quality_dkim (027) /
-- signal_quality_dmarc (028) / signal_quality_caa (029) / signal_quality_dnssec (030).
-- Row-independent (no population resolution required, like DMARC/DNSSEC).
--
-- MTA-STS is reclassified Category C → Category D per ADR-COL-008 (Founder
-- Accepted 2026-07-08). This quality model is independently derived from Category D
-- evidence and does NOT inherit the superseded Category C allocation
-- (SLG-030/032/033/034/035/036/037, all flagged category-superseded).
--
-- ── Score model (MTASTS-QM-v1.0: design SLG-086, calibrated SLG-087) ─────────
--   PRIMARY — a disposition/policy-primary state, read from the JOINT
--   (dns_sts_present × policy_mode) axis, gated by RFC 8461 §3.1 discovery
--   sequencing (policy_mode is only consulted when dns_sts_present=true).
--     ENFORCE             = 100  (only state that changes real delivery behaviour;
--                                 389/17,057 domains, NOB-MTASTS-001, SLG-083 §2)
--     TESTING              =  25  (no delivery-behaviour change; TLS-RPT reporting
--                                 value unrealised nationally — SLG-036/037 0% adoption;
--                                 193/17,057 domains)
--     NONE                 =  15  (genuine disclosure, zero operative protection;
--                                 8/17,057 domains)
--     PUBLISHED_UNUSABLE   =   0  (DNS present, no usable policy — fetch/parse failed;
--                                 26/17,057 domains)
--     ABSENT               =   0  (DNS absent — CONFIRMED floor; includes 155 domains
--                                 nationally with a fetchable-but-undiscoverable policy,
--                                 SLG-082 L-1/SLG-086 §2; 16,372/17,057 domains)
--     unobserved (dns_sts_present null, OR true with policy outcome undetermined)
--       → NOT SCORED — NO ROW is emitted (SLG-043 P1). 69/17,057 domains.
--   MULTIPLIER (reduce-only, multiplicative), applied only within ENFORCE:
--     Short cache lifetime (max_age < 604,800s / 1 week)   ×0.95   (SLG-087 §2;
--       68/389 ENFORCE domains, 17.48%)
--   Four further Secondary dimensions (own-endpoint TLS validity; redirect-based
--   retrieval; multiple DNS records; non-standard policy fields) are COMPUTED and
--   FLAGGED but UNCALIBRATED (near-zero/zero evidence within national ENFORCE
--   population — SLG-085 §2) — NEVER applied to final_score, mirroring the
--   CAA-M3 / DNSSEC-legacy-algorithm precedent (retain-and-flag).
--   Realised values: 0, 15, 25, 95, 100.
--
-- ── Provenance without run_id (as for DKIM/DMARC/CAA/DNSSEC) ─────────────────
-- signal_facts_mtasts is a v0 schema with NO run_id column (SLG-083 §1), so the
-- quality layer defines its own governed run identifier (deterministic from
-- run_label) AND records the baseline window that fixes the evidence exactly.
--
-- Apply via backend/tooling/db/apply-migration.js (Supabase MCP is read-only for DDL).
-- Idempotent.

CREATE TABLE IF NOT EXISTS signal_quality_mtasts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                TEXT        NOT NULL,

  -- ── Governed run identity ──────────────────────────────────────────────────
  run_id                UUID        NOT NULL,                     -- deterministic from run_label
  run_label             TEXT        NOT NULL,                     -- 'NOB-MTASTS-001'
  baseline_window_start TIMESTAMPTZ NOT NULL,                     -- collected_at window (SLG-083 §1)
  baseline_window_end   TIMESTAMPTZ NOT NULL,

  quality_version       TEXT        NOT NULL DEFAULT '1.0',       -- MTASTS-QM-v1.0
  signal_version        INTEGER     NOT NULL DEFAULT 1,           -- mtasts collector version scored
  collected_at          TIMESTAMPTZ NOT NULL,                     -- observation time of the scored facts

  -- ── Primary state ─────────────────────────────────────────────────────────
  primary_score         INTEGER     NOT NULL,                     -- 100 | 25 | 15 | 0
  primary_label         TEXT        NOT NULL,                     -- ENFORCE | TESTING | NONE | PUBLISHED_UNUSABLE | ABSENT

  -- ── Final normalised quality score (0–100, after the reduce-only multiplier) ─
  final_score           NUMERIC     NOT NULL,

  -- Which multipliers fired: [{"name":"Short cache lifetime (<1 week)","factor":0.95}]
  multipliers_applied   JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- ── Uncalibrated conditions, evaluated and recorded, never applied ─────────
  uncalibrated_flags    JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_quality_mtasts_final_range   CHECK (final_score >= 0 AND final_score <= 100),
  CONSTRAINT signal_quality_mtasts_primary_range CHECK (primary_score IN (0, 15, 25, 100)),
  CONSTRAINT signal_quality_mtasts_primary_label CHECK (primary_label IN ('ABSENT','PUBLISHED_UNUSABLE','NONE','TESTING','ENFORCE')),
  -- Ordinal preservation (SLG-087 §4): bands are disjoint and non-inverting.
  -- The only calibrated multiplier (×0.95) is confined to ENFORCE, so the worst
  -- ENFORCE outcome (95) always exceeds TESTING (25) by a 70-point margin; TESTING
  -- and NONE take exactly one fixed value each (no multiplier applies to either).
  CONSTRAINT signal_quality_mtasts_bands CHECK (
       (primary_label = 'ENFORCE'            AND final_score >= 95 AND final_score <= 100)
    OR (primary_label = 'TESTING'            AND final_score  = 25)
    OR (primary_label = 'NONE'               AND final_score  = 15)
    OR (primary_label = 'PUBLISHED_UNUSABLE' AND final_score  =  0)
    OR (primary_label = 'ABSENT'             AND final_score  =  0)
  )
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_mtasts_domain    ON signal_quality_mtasts (domain);
CREATE INDEX IF NOT EXISTS idx_signal_quality_mtasts_run       ON signal_quality_mtasts (run_id);
CREATE INDEX IF NOT EXISTS idx_signal_quality_mtasts_run_label ON signal_quality_mtasts (run_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_mtasts_final     ON signal_quality_mtasts (final_score);
CREATE INDEX IF NOT EXISTS idx_signal_quality_mtasts_primary   ON signal_quality_mtasts (primary_label);
