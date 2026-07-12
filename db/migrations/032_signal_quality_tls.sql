-- ── Migration 032: TLS Configuration Quality Scores ────────────────────────
-- Stores the normalised 0–100 TLS Quality Score (Category D – Signal 1),
-- quality_version = '1.0' (TLS-QM-v1.0), produced by
-- backend/observatory/quality/tls-quality.js from immutable TLS observations
-- (signal_tls_v1) over the authoritative baseline NOB-TLS-001.
--
-- SEPARATION OF CONCERNS: observations live in signal_tls_v1 and remain the pure,
-- score-free record. This table is the DERIVED quality layer — one row per domain
-- per quality run. It never mutates an observation.
-- Mirrors signal_quality_spf/dkim/dmarc/caa/dnssec/mtasts (migrations 026–031).
--
-- ── Score model (TLS-QM-v1.0: review SLG-093, baseline SLG-094, validation
--    SLG-095, variability SLG-096, design SLG-097, calibration SLG-098) ──
--   PRIMARY — a single ordered disposition ladder read from
--   (negotiated_version, forward-secrecy-equivalent). Not a two-axis product
--   (unlike DNSSEC's DS×DNSKEY) — forward secrecy is a partial derivative of
--   version, not an independent fact (SLG-096 §2.2).
--     CEILING       = 100  (TLSv1.3 — RFC 8446-mandated ephemeral exchange;
--                           always forward-secret. 91.365% of NOB-TLS-001)
--     UPPER_MIDDLE  =  90  (TLSv1.2 + ECDHE/DHE — forward-secret, NIST/NCSC-
--                           acceptable. 8.545% of NOB-TLS-001)
--     LOWER_MIDDLE  =  25  (TLSv1.2 + static-RSA — not forward-secret.
--                           0.107% of NOB-TLS-001; SLG-097 §2 binding
--                           resolution of SLG-095's L-4 finding applied —
--                           classified from the raw `TLS_RSA_WITH_` cipher
--                           standard name, not the collector's null-deriving field)
--     FLOOR         =   0  (TLSv1.1/TLSv1/SSLv3 — RFC 7568-deprecated.
--                           Structurally-defined; 0% national population)
--     unobserved (endpoint_state != RESPONSE_OBSERVED) → NOT SCORED — NO ROW
--       is emitted (Unknown ≠ Absent, SOT-TLS-001 §6.1)
--   No Secondary multiplier (SLG-097 §3 — none independently discriminating).
--   ALPN/HTTP-2 and symmetric-algorithm/MAC-hash choice are COMPUTED and
--   FLAGGED (evidence JSONB) but NEVER applied to final_score (SLG-097 §4).
--   Realised values: 0 (structural only), 25, 90, 100.
--
-- ── Provenance with run_id (signal_tls_v1 IS a v1 schema, unlike DNSSEC/MTA-STS)
-- signal_tls_v1 already carries a `run_id` column (migration 016) — the quality
-- layer's run_id here identifies the SCORING run, distinct from (but referencing)
-- the collection run_id it was scored from.
--
-- Apply via backend/tooling/db/apply-migration.js (Supabase MCP is read-only for DDL).
-- Idempotent.

CREATE TABLE IF NOT EXISTS signal_quality_tls (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                TEXT        NOT NULL,

  -- ── Governed run identity ──────────────────────────────────────────────────
  run_id                UUID        NOT NULL,                     -- this scoring run
  run_label             TEXT        NOT NULL,                     -- 'NOB-TLS-001'
  source_run_id         UUID        NOT NULL,                     -- signal_tls_v1.run_id scored from

  quality_version       TEXT        NOT NULL DEFAULT '1.0',       -- TLS-QM-v1.0
  signal_version        TEXT        NOT NULL DEFAULT '1.0.0',     -- tls collector version scored
  collected_at          TIMESTAMPTZ NOT NULL,                     -- observation time of the scored facts

  -- ── Primary state ─────────────────────────────────────────────────────────
  primary_score         INTEGER     NOT NULL,                     -- 100 | 90 | 25 | 0
  primary_label         TEXT        NOT NULL,                     -- CEILING | UPPER_MIDDLE | LOWER_MIDDLE | FLOOR

  -- ── Final normalised quality score (0–100; no multiplier in v1.0, equals primary) ─
  final_score           NUMERIC     NOT NULL,

  -- Evidence-only fields, computed and flagged, never applied to final_score
  -- (SLG-097 §4): e.g. ["ALPN_NOT_H2"], ["ALPN_NOT_NEGOTIATED"], [] (h2 negotiated).
  evidence_flags        JSONB       NOT NULL DEFAULT '[]'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_quality_tls_final_range   CHECK (final_score >= 0 AND final_score <= 100),
  CONSTRAINT signal_quality_tls_primary_range CHECK (primary_score IN (0, 25, 90, 100)),
  CONSTRAINT signal_quality_tls_primary_label CHECK (primary_label IN ('FLOOR','LOWER_MIDDLE','UPPER_MIDDLE','CEILING')),
  -- Ordinal preservation (SLG-098 §4): no multiplier exists in v1.0, so
  -- final_score always equals primary_score exactly.
  CONSTRAINT signal_quality_tls_final_equals_primary CHECK (final_score = primary_score),
  -- One score per domain per scoring run.
  CONSTRAINT signal_quality_tls_run_domain_unique UNIQUE (run_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_signal_quality_tls_domain    ON signal_quality_tls (domain);
CREATE INDEX IF NOT EXISTS idx_signal_quality_tls_run       ON signal_quality_tls (run_id);
CREATE INDEX IF NOT EXISTS idx_signal_quality_tls_run_label ON signal_quality_tls (run_label);
CREATE INDEX IF NOT EXISTS idx_signal_quality_tls_final     ON signal_quality_tls (final_score);
CREATE INDEX IF NOT EXISTS idx_signal_quality_tls_primary   ON signal_quality_tls (primary_label);
