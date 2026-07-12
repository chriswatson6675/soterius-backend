-- ── Migration 034: Security.txt Quality Scores ─────────────────────────────
-- Stores the normalised 0–100 Security.txt Quality Score (Category C —
-- Control Transparency), quality_version = '1.0' (SECURITYTXT-QM-v1.0),
-- produced by backend/observatory/quality/securitytxt-quality.js from
-- immutable security.txt observations (signal_securitytxt_v1) over the
-- authoritative baseline NOB-SECURITYTXT-001.
--
-- SEPARATION OF CONCERNS: observations live in signal_securitytxt_v1 and
-- remain the pure, score-free record. This table is the DERIVED quality
-- layer — one row per domain per quality run. It never mutates an
-- observation. Mirrors signal_quality_spf/dkim/dmarc/caa/dnssec/mtasts/tls/
-- certificate (migrations 026–033).
--
-- ── Score model (SECURITYTXT-QM-v1.0: review SLG-123, baseline SLG-124,
--    validation SLG-125, landscape SLG-126, design SLG-127, calibration
--    SLG-128) ──
--   Prerequisite gate (binding, SLG-125/126): a domain is only eligible for a
--   non-FLOOR state if fetch_state = FOUND AND content_type conforms to
--   text/plain at the SAME location (canonical checked first, then legacy).
--   A text/html (or other non-conformant) response — the dominant SPA
--   catch-all false-positive pattern found nationally — is not a security.txt
--   file under RFC 9116 §3's own MUST-level media-type requirement.
--
--   PRIMARY — a single ordered disposition ladder (nested-precondition, not
--   additive — SLG-126 §5 / SLG-127 §2):
--     CEILING  = 100  (content-type conformant, Contact present, Expires
--                      present and future-dated. 206/17,036 = 1.209% of
--                      NOB-SECURITYTXT-001)
--     MIDDLE   =  50  (content-type conformant, Contact present, Expires
--                      missing/past-dated/unparsable — currency unverifiable.
--                      146/17,036 = 0.857%. Revised from the SLG-127
--                      candidate of 60 to 50 at SLG-128 Stage 6 sensitivity
--                      testing — restores this repository's convention of
--                      reserving the largest ladder gap for the ceiling
--                      transition, and better reflects RFC 9116's textually
--                      equal mandatory status for Contact/Expires)
--     MINIMAL  =  10  (content-type conformant, Contact missing — structurally
--                      correct file failing at the one essential field.
--                      13/17,036 = 0.076%)
--     FLOOR    =   0  (content-type non-conformant, OR file_state = ABSENT.
--                      16,671/17,036 = 97.86%)
--     file_state = INDETERMINATE → NOT SCORED — NO ROW is emitted
--       (Unknown ≠ Absent, reconfirmed SLG-125 §2)
--   No Secondary multiplier (SLG-127 §4 — none independently justified).
--   All seven optional RFC 9116 fields (Encryption, PGP-signing/content_state,
--   Canonical, Preferred-Languages, Policy, Acknowledgments, Hiring) are
--   COMPUTED and FLAGGED (evidence_flags JSONB) but NEVER applied to
--   final_score (SLG-127 §3, reconfirmed at national scale SLG-128 §6).
--   Realised values: 0, 10, 50, 100.
--
-- ── Provenance with run_id (signal_securitytxt_v1 is a v1 schema, migration 013)
-- signal_securitytxt_v1 already carries a run_id column — the quality layer's
-- run_id here identifies the SCORING run, distinct from (but referencing) the
-- collection run_id it was scored from.
--
-- Apply via backend/tooling/db/apply-migration.js (Supabase MCP is read-only for DDL).
-- Idempotent.

CREATE TABLE IF NOT EXISTS signal_quality_securitytxt (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                TEXT        NOT NULL,

  -- ── Governed run identity ──────────────────────────────────────────────────
  run_id                UUID        NOT NULL,                     -- this scoring run
  run_label             TEXT        NOT NULL,                     -- 'NOB-SECURITYTXT-001'
  source_run_id         UUID        NOT NULL,                     -- signal_securitytxt_v1.run_id scored from

  quality_version       TEXT        NOT NULL DEFAULT '1.0',       -- SECURITYTXT-QM-v1.0
  signal_version        TEXT        NOT NULL DEFAULT '1.0.0',     -- securitytxt collector version scored
  collected_at          TIMESTAMPTZ NOT NULL,                     -- observation time of the scored facts

  -- ── Primary state ─────────────────────────────────────────────────────────
  primary_score         INTEGER     NOT NULL,                     -- 100 | 50 | 10 | 0
  primary_label         TEXT        NOT NULL,                     -- CEILING | MIDDLE | MINIMAL | FLOOR

  -- ── Final normalised quality score (0–100; no multiplier in v1.0, equals primary) ─
  final_score           NUMERIC     NOT NULL,

  -- Evidence-only fields, computed and flagged, never applied to final_score
  -- (SLG-127 §3): e.g. ["ENCRYPTION_PRESENT","CANONICAL_PRESENT"], [].
  evidence_flags        JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_quality_securitytxt_final_range   CHECK (final_score >= 0 AND final_score <= 100),
  CONSTRAINT signal_quality_securitytxt_primary_range CHECK (primary_score IN (0, 10, 50, 100)),
  CONSTRAINT signal_quality_securitytxt_primary_label CHECK (primary_label IN ('FLOOR','MINIMAL','MIDDLE','CEILING')),
  -- Ordinal preservation (SLG-128 §4): no multiplier exists in v1.0, so
  -- final_score always equals primary_score exactly.
  CONSTRAINT signal_quality_securitytxt_final_equals_primary CHECK (final_score = primary_score),
  -- One score per domain per scoring run.
  CONSTRAINT signal_quality_securitytxt_run_domain_unique UNIQUE (run_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_securitytxt_domain    ON signal_quality_securitytxt (domain);
CREATE INDEX IF NOT EXISTS idx_signal_quality_securitytxt_run       ON signal_quality_securitytxt (run_id);
CREATE INDEX IF NOT EXISTS idx_signal_quality_securitytxt_run_label ON signal_quality_securitytxt (run_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_securitytxt_final     ON signal_quality_securitytxt (final_score);
CREATE INDEX IF NOT EXISTS idx_signal_quality_securitytxt_primary   ON signal_quality_securitytxt (primary_label);
