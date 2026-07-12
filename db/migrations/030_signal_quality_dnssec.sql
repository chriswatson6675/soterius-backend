-- ── Migration 030: DNSSEC Trust Quality Scores ──────────────────────────────
-- Stores the normalised 0–100 DNSSEC Quality Score (Category B – Signal 2),
-- quality_version = '1.0' (DNSSEC-QM-v1.0), produced by
-- backend/observatory/quality/dnssec-quality.js from immutable DNSSEC observations
-- (signal_facts_dnssec) over the authoritative baseline NOB-DNSSEC-001.
--
-- SEPARATION OF CONCERNS: observations live in signal_facts_dnssec and remain the
-- pure, score-free record. This table is the DERIVED quality layer — one row per
-- domain per quality run. It never mutates an observation.
-- Mirrors signal_quality_spf (mig 026) / signal_quality_dkim (027) / signal_quality_dmarc (028)
-- / signal_quality_caa (029). Row-independent, like DMARC (no population resolution
-- required, unlike CAA's RFC 8659 §3 tree-climb inheritance).
--
-- ── Score model (DNSSEC-QM-v1.0: design SLG-078, corrected SLG-079, calibrated SLG-080) ──
--   PRIMARY — a presence/configuration state derived from the joint DS×DNSKEY status.
--   Founder ordinal decision (2026-07-08): Unsigned → Island of Security → Anchored.
--     ANCHORED  = 100  (DS present AND DNSKEY present — RFC 4035 §5.2 anchoring test;
--                       682/682 zones cryptographically confirmed at Stage 3, SLG-077 §6.9)
--     ISLAND    =  40  (DNSKEY present, DS absent — RFC 4033 §2; value anchored to
--                       DMARC-QM-v1.0's frozen p=none=40, SLG-080 §2.3 — no DNSSEC-internal
--                       decomposition available; Founder rationale cites DMARC precedent)
--     UNSIGNED  =   0  (DS absent, DNSKEY absent — RFC 4035 §5.2 Insecure. CONFIRMED floor)
--     unobserved (either axis) → NOT SCORED — NO ROW is emitted (SLG-043 P1)
--     DS-present/DNSKEY-absent → empirically impossible nationally (n=0/17,057) —
--       NO ROW is ever emitted for this state either (ANOMALOUS_STATE_DS_WITHOUT_DNSKEY)
--   MULTIPLIER (reduce-only, multiplicative), applied only within ANCHORED:
--     SHA-1 DS digest present   ×0.95   (RFC 8624 §3.3 NOT RECOMMENDED; SLG-080 §3.1)
--   DNSKEY-algorithm modernity (RFC 8624 §3.1, algorithms 5/7/10) is COMPUTED and FLAGGED
--     but UNCALIBRATED (n=2/682 in scope, SLG-079 §5) — NEVER applied to final_score,
--     mirroring CAA migration 029's treatment of its own uncalibrated M3.
--   Realised values: 0, 40, 95, 100.
--
-- ── Provenance without run_id (as for DKIM/DMARC/CAA) ────────────────────────
-- signal_facts_dnssec is a v0 schema with NO run_id column (SLG-075 §11; SLG-076 G2), so
-- the quality layer defines its own governed run identifier (deterministic from
-- run_label) AND records the baseline window that fixes the evidence exactly.
--
-- Apply via backend/tooling/db/apply-migration.js (Supabase MCP is read-only for DDL).
-- Idempotent.

CREATE TABLE IF NOT EXISTS signal_quality_dnssec (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                TEXT        NOT NULL,

  -- ── Governed run identity ──────────────────────────────────────────────────
  run_id                UUID        NOT NULL,                     -- deterministic from run_label
  run_label             TEXT        NOT NULL,                     -- 'NOB-DNSSEC-001'
  baseline_window_start TIMESTAMPTZ NOT NULL,                     -- collected_at window (SLG-076 §3.1)
  baseline_window_end   TIMESTAMPTZ NOT NULL,

  quality_version       TEXT        NOT NULL DEFAULT '1.0',       -- DNSSEC-QM-v1.0
  signal_version        INTEGER     NOT NULL DEFAULT 1,           -- dnssec collector version scored
  collected_at          TIMESTAMPTZ NOT NULL,                     -- observation time of the scored facts

  -- ── Primary state ─────────────────────────────────────────────────────────
  primary_score         INTEGER     NOT NULL,                     -- 100 | 40 | 0
  primary_label         TEXT        NOT NULL,                     -- ANCHORED | ISLAND | UNSIGNED

  -- ── Final normalised quality score (0–100, after the reduce-only multiplier) ─
  final_score           NUMERIC     NOT NULL,

  -- Which multipliers fired: [{"name":"SHA-1 DS digest present","factor":0.95}]
  multipliers_applied   JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- ── Uncalibrated condition, evaluated and recorded, never applied ──────────
  legacy_dnskey_algorithm_flag BOOLEAN NOT NULL DEFAULT FALSE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_quality_dnssec_final_range   CHECK (final_score >= 0 AND final_score <= 100),
  CONSTRAINT signal_quality_dnssec_primary_range CHECK (primary_score IN (0, 40, 100)),
  CONSTRAINT signal_quality_dnssec_primary_label CHECK (primary_label IN ('UNSIGNED','ISLAND','ANCHORED')),
  -- Ordinal preservation (SLG-080 §6): bands are disjoint and non-inverting.
  -- The only calibrated multiplier is ×0.95, so the worst ANCHORED outcome (95) always
  -- exceeds ISLAND (40) by a 55-point margin — no score can cross a band boundary.
  CONSTRAINT signal_quality_dnssec_bands CHECK (
       (primary_score = 100 AND final_score >= 95  AND final_score <= 100)
    OR (primary_score =  40 AND final_score  = 40)
    OR (primary_score =   0 AND final_score  =  0)
  )
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_dnssec_domain    ON signal_quality_dnssec (domain);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dnssec_run       ON signal_quality_dnssec (run_id);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dnssec_run_label ON signal_quality_dnssec (run_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dnssec_final     ON signal_quality_dnssec (final_score);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dnssec_primary   ON signal_quality_dnssec (primary_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_dnssec_legacy    ON signal_quality_dnssec (legacy_dnskey_algorithm_flag) WHERE legacy_dnskey_algorithm_flag;
