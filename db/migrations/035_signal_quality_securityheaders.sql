-- ── Migration 035: Security Headers Quality Scores ──────────────────────────
-- Stores the normalised 0–100 Security Headers Quality Score (Category C —
-- Control Transparency), quality_version = '1.0' (SECURITYHEADERS-QM-v1.0),
-- produced by backend/observatory/quality/securityheaders-quality.js from
-- immutable observations (signal_securityheaders_v1) over the authoritative
-- baseline NOB-SECURITYHEADERS-001.
--
-- PERSISTENCE COMMISSIONING NOTE: SLG-120 froze SECURITYHEADERS-QM-v1.0 but did
-- NOT include a persistence/commissioning stage (unlike SLG-129 for security.txt
-- or SLG-081 for DNSSEC). This migration + the nob-securityheaders-001 loader
-- are that deferred [P] commissioning, performed WITHOUT any change to the frozen
-- model (the loader imports securityheaders-quality.js and calls it — it does not
-- re-implement the calibration). SLG-006 should be updated to record the new
-- persisted table.
--
-- SEPARATION OF CONCERNS: observations live in signal_securityheaders_v1 and
-- remain the pure, score-free record. This table is the DERIVED quality layer —
-- one row per domain per quality run. It never mutates an observation.
-- Mirrors signal_quality_spf…securitytxt (migrations 026–034).
--
-- ── Score model (SECURITYHEADERS-QM-v1.0: structure SLG-116, calibration
--    SLG-117, validation SLG-118/119, freeze SLG-120) ──
--   ADDITIVE weighted checklist (NOT a single-gate-plus-multiplier ladder), on
--   the signal's own internal 0–100 scale:
--     security_headers_quality = MIN(100, MAX(0,
--         Σ candidate contributions + Σ contextual bonuses + disclosure_allowance))
--   Candidates: Tier1 HSTS/CSP 20 each · Tier2 X-Frame-Options/X-Content-Type-
--     Options 12 each · Tier3 Referrer-Policy/Permissions-Policy 8 each.
--   Contextual: CSP-Report-Only +2 (only when CSP present) · isolation bundle
--     COOP+COEP +5 / one-of +2 · CORP +3.
--   disclosure_allowance = MAX(0, 10 − 3×[Server] − 7×[X-Powered-By]).
--   13 dormant headers excluded (SLG-116 §6). HSTS retained in-signal (SLG-133).
--   unobserved (endpoint_state != RESPONSE_OBSERVED) → NOT SCORED — NO ROW
--     (Unknown ≠ Absent, SLG-116 §2). No primary/ladder state — additive only.
--   Realised national (NOB-SECURITYHEADERS-001): mean 27.514, median 19,
--     SD 26.542, 81 distinct, structural max observed 98.
--
-- ── Provenance with run_id (signal_securityheaders_v1 IS a v1 schema)
-- signal_securityheaders_v1 carries a run_id (migration 014) — the quality
-- layer's run_id here identifies the SCORING run, distinct from (but referencing
-- via source_run_id) the collection run it was scored from.
--
-- Apply via backend/tooling/db/apply-migration.js (Supabase MCP is read-only for
-- DDL). Idempotent.

CREATE TABLE IF NOT EXISTS signal_quality_securityheaders (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                TEXT        NOT NULL,

  -- ── Governed run identity ──────────────────────────────────────────────────
  run_id                UUID        NOT NULL,                     -- this scoring run
  run_label             TEXT        NOT NULL,                     -- 'NOB-SECURITYHEADERS-001'
  source_run_id         UUID        NOT NULL,                     -- signal_securityheaders_v1.run_id scored from

  quality_version       TEXT        NOT NULL DEFAULT '1.0',       -- SECURITYHEADERS-QM-v1.0
  signal_version        TEXT        NOT NULL DEFAULT '1.0.0',     -- securityheaders collector version scored
  collected_at          TIMESTAMPTZ NOT NULL,                     -- observation time of the scored facts

  -- ── Final normalised quality score (0–100; additive model, no primary state) ─
  final_score           NUMERIC     NOT NULL,

  -- Additive breakdown { candidates, contextual, disclosureAllowance, raw } and
  -- evidence (which headers were present) — diagnostic, never re-scored.
  breakdown             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  evidence              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  evidence_flags        JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_quality_securityheaders_final_range CHECK (final_score >= 0 AND final_score <= 100),
  -- One score per domain per scoring run.
  CONSTRAINT signal_quality_securityheaders_run_domain_unique UNIQUE (run_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_securityheaders_domain    ON signal_quality_securityheaders (domain);
CREATE INDEX IF NOT EXISTS idx_signal_quality_securityheaders_run       ON signal_quality_securityheaders (run_id);
CREATE INDEX IF NOT EXISTS idx_signal_quality_securityheaders_run_label ON signal_quality_securityheaders (run_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_securityheaders_final     ON signal_quality_securityheaders (final_score);
