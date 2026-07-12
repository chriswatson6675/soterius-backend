-- Migration 036: SOT-SECURITYHEADERS-001 v2 — source-authentication verdict
-- Table: signal_securityheaders_v1 (additive; no data rewrite)
--
-- Governance: SLG-136 (COLLECT-PHILOSOPHY-v1.0) §7 R-1 + §10 — Security Headers
--   harmonisation. The v1 collector connected with rejectUnauthorized:true, so a
--   failed certificate discarded BOTH the headers AND the certificate verdict
--   (endpoint_state=TLS_ERROR, empty header_pairs) — the C-4/C-7 DEVIATION that
--   produced the 653-domain Security-Headers/TLS discrepancy. v2 observes the
--   response over an unauthenticated origin and records the source-authentication
--   verdict inseparably (C-4) with its specific cause (C-5).
--
-- These two columns are the NORMALISED MIRROR of the terminal verdict that the
-- collector also stores verbatim inside the https_fetch JSONB (and per redirect
-- hop). They exist for query/index and Quality Model segmentation, exactly as
-- endpoint_state mirrors https_fetch.fetch_outcome.
--
-- Value vocabulary (mirrors tls-collection-layer.js — the SLG-136 §3.1 reference):
--   tls_verification_result:
--     CHAIN_VERIFIED | CERT_EXPIRED | CERT_NOT_YET_VALID | HOSTNAME_MISMATCH |
--     SELF_SIGNED | SELF_SIGNED_IN_CHAIN | CHAIN_UNVERIFIABLE | CERT_REVOKED |
--     OTHER_TLS_ERROR | UNKNOWN | NULL
--   tls_error_code: the raw OpenSSL authorizationError code, or NULL.
--
-- NULLABLE by design:
--   - legacy v1 rows (signal_version = 'SOT-SECURITYHEADERS-001-v1') predate the
--     verdict and remain NULL — never back-filled (append-only; no data rewrite);
--   - a genuine transport / TLS-protocol failure (endpoint_state=TLS_ERROR /
--     CONNECTION_ERROR / TIMEOUT) establishes no verdict → NULL;
--   - the HTTP probe carries no TLS verdict.
--
-- v2 rows are distinguishable from v1 by signal_version alone.
--
-- Apply via Supabase Dashboard → SQL Editor (Supabase MCP is read-only; DDL is
-- applied through backend/tooling/db/apply-migration.js).
-- Idempotent: safe to run more than once.

ALTER TABLE signal_securityheaders_v1
  ADD COLUMN IF NOT EXISTS tls_verification_result text,
  ADD COLUMN IF NOT EXISTS tls_error_code          text;

-- Segmentation index — the Quality Model layer and Stage-5 validation partition
-- observed rows by verdict (e.g. CHAIN_VERIFIED vs non-authenticated capture).
CREATE INDEX IF NOT EXISTS idx_sshv1_tls_verification_result
  ON signal_securityheaders_v1 (tls_verification_result);

-- ── Verification ──────────────────────────────────────────────────────────────
--
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'signal_securityheaders_v1'
--    AND column_name IN ('tls_verification_result', 'tls_error_code');
--
-- After the v2 baseline run, distribution of recovered captures:
-- SELECT tls_verification_result, count(*)
--   FROM signal_securityheaders_v1
--  WHERE signal_version = 'SOT-SECURITYHEADERS-001-v2'
--  GROUP BY tls_verification_result ORDER BY 2 DESC;
