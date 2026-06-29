-- Migration 015: SOT-CERTIFICATE-001 — Certificate Trust Facts Signal
-- Table: signal_certificate_v1
--
-- Authority:
--   SOT-CERTIFICATE-001 v1.0 — Implementation Active
--   TLS_COLLECTION_DOMAIN_LAYER_IMPLEMENTATION.md v1.1
--   TLS Collection Domain Layer Conformance Review — Outcome B (2026-06-19)
--
-- Storage model:
--   ADR-SYS-006 (JSONB evidence blocks — v1 schema).
--   Full evidence block in 'evidence' JSONB column.
--   Selected scalar fields promoted to indexed columns for common access patterns.
--   No scores, ratings, or interpretations stored.
--   JSONB structure matches the Certificate Evidence Object from certificate-extractor.js.
--
-- Category D collection model:
--   The TLS Collection Domain Layer (tls-collection-layer.js) establishes one TLS
--   session per domain per run. The Certificate Evidence Extractor (certificate-extractor.js)
--   projects the certificate-relevant fields. This table stores that projection.
--   SOT-TLS-001 evidence is stored separately in signal_tls_v1 (Migration 016).
--
-- endpoint_state values (three-state; from TLS_LAYER_IMPL_001 §6):
--   RESPONSE_OBSERVED  — TLS handshake completed (any certificate outcome)
--   TLS_ERROR          — TCP connected; TLS handshake failed at protocol layer
--   CONNECTION_ERROR   — TCP connection could not be established
--
-- certificate_present values (set only on RESPONSE_OBSERVED):
--   CERTIFICATE_PRESENTED   — server presented a certificate
--   NO_CERTIFICATE          — server did not present a certificate
--   HANDSHAKE_INCOMPLETE    — certificate object present but essential fields absent
--   null                    — TLS_ERROR or CONNECTION_ERROR outcome
--
-- Conformance Review nullability notes (Outcome B, 2026-06-19):
--   leaf_is_wildcard  — nullable. null means "leaf_san_entries is empty; field inapplicable."
--                       This is not the same as false ("SANs present, none is a wildcard").
--                       Never assume null = false for this column. (Finding D-2)
--   leaf_is_self_signed — nullable. null means DN extraction failed (both DNs null).
--   leaf_basic_constraints_ca — nullable. Depends on undocumented peerCert.ca property;
--                       may be null even on CERTIFICATE_PRESENTED records. (Finding AR-1)
--   All other promoted scalar columns are nullable: null when endpoint_state != RESPONSE_OBSERVED
--   or when the specific certificate field was not present.
--
-- v1 limitations:
--   leaf_policy_oids is always [] (ASN.1 parsing not implemented; v2 enhancement).
--   leaf_extension_parse_errors always contains 'Certificate Policies' on
--   CERTIFICATE_PRESENTED records — this is correct and expected.
--   leaf_basic_constraints_pathlen is always null (pathLenConstraint not exposed).
--   session_ticket_issued, ocsp_stapling_present, key_share_group are not stored
--   in this table (TLS-layer facts belong to signal_tls_v1).
--
-- Rerun strategy:
--   run_id groups all rows from a single cohort run.
--   (run_id, domain) is unique: prevents duplicate inserts within one run.
--   Multiple run_ids per domain are allowed: historical reruns are preserved.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Idempotent: safe to run more than once.

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_certificate_v1 (

  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            uuid        NOT NULL,
  domain            text        NOT NULL,
  collected_at      timestamptz NOT NULL,
  signal_version    text        NOT NULL,
  collector_version text        NOT NULL,

  -- ── Promoted scalar columns ────────────────────────────────────────────────
  -- Indexed for common access patterns per ADR-SYS-006 and SOT-CERTIFICATE-001 §4.5.
  -- All nullable where the Layer may return null (see nullability notes above).

  -- Connection outcome (always present)
  endpoint_state          text        NOT NULL,

  -- Certificate presence (null when TLS_ERROR or CONNECTION_ERROR)
  certificate_present     text,

  -- TLS verification error code (null when CHAIN_VERIFIED or no certificate)
  tls_error_code          text,

  -- Days to expiry at collected_at time (negative = expired; null if no cert)
  leaf_days_remaining     integer,

  -- Issuer identity (null if no cert or field absent from cert)
  leaf_issuer_cn          text,
  leaf_issuer_o           text,

  -- Subject identity
  leaf_subject_cn         text,

  -- Structural indicators
  -- leaf_is_self_signed: null when DN extraction failed
  leaf_is_self_signed     boolean,

  -- leaf_is_wildcard: null when leaf_san_entries is empty (no SAN extension).
  -- null ≠ false here. See conformance review D-2.
  leaf_is_wildcard        boolean,

  -- Certificate identity (hex, no colons, lowercase)
  leaf_fingerprint_sha256 text,

  -- ── Full JSONB evidence block ──────────────────────────────────────────────
  -- Contains the complete Certificate Evidence Object from certificate-extractor.js.
  -- All fields from the TLS Session Evidence Object owned by SOT-CERTIFICATE-001,
  -- plus shared context fields required to interpret the evidence.
  --
  -- Top-level structure:
  --   endpoint_state, collected_at, collection_hostname,
  --   connection_error_code, connection_error_msg,
  --   certificate_present, tls_verification_result, tls_error_code,
  --   leaf_subject_cn, leaf_subject_o, leaf_subject_dn_raw,
  --   leaf_issuer_cn, leaf_issuer_o, leaf_issuer_dn_raw,
  --   leaf_serial_number, leaf_fingerprint_sha256, leaf_signature_algorithm,
  --   leaf_key_type, leaf_key_bits, leaf_key_curve,
  --   leaf_not_before, leaf_not_after, leaf_days_remaining, leaf_lifetime_days,
  --   leaf_san_entries[], leaf_san_count, leaf_is_wildcard, leaf_is_self_signed,
  --   leaf_aia_ocsp_urls[], leaf_aia_ca_issuers_urls[], leaf_policy_oids[],
  --   leaf_basic_constraints_ca, leaf_basic_constraints_pathlen,
  --   leaf_extension_parse_errors[],
  --   chain_intermediates[], cert_chain_depth, cert_chain_complete
  evidence          jsonb       NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),

  -- ── Constraints ───────────────────────────────────────────────────────────

  CONSTRAINT scv1_endpoint_state_values CHECK (
    endpoint_state IN (
      'RESPONSE_OBSERVED',
      'TLS_ERROR',
      'CONNECTION_ERROR'
    )
  ),

  CONSTRAINT scv1_certificate_present_values CHECK (
    certificate_present IS NULL OR certificate_present IN (
      'CERTIFICATE_PRESENTED',
      'NO_CERTIFICATE',
      'HANDSHAKE_INCOMPLETE'
    )
  ),

  CONSTRAINT scv1_signal_version_non_empty CHECK (
    signal_version <> ''
  ),

  CONSTRAINT scv1_collector_version_non_empty CHECK (
    collector_version <> ''
  ),

  CONSTRAINT scv1_fingerprint_format CHECK (
    leaf_fingerprint_sha256 IS NULL OR
    (leaf_fingerprint_sha256 ~ '^[0-9a-f]{64}$')
  ),

  -- Unique per run: prevents re-inserting the same domain in the same run
  CONSTRAINT scv1_run_domain_unique UNIQUE (run_id, domain)

);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary access patterns

CREATE INDEX IF NOT EXISTS idx_scv1_domain
  ON signal_certificate_v1 (domain);

CREATE INDEX IF NOT EXISTS idx_scv1_domain_collected_at
  ON signal_certificate_v1 (domain, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_scv1_collected_at
  ON signal_certificate_v1 (collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_scv1_run_id
  ON signal_certificate_v1 (run_id);

-- State queries

CREATE INDEX IF NOT EXISTS idx_scv1_endpoint_state
  ON signal_certificate_v1 (endpoint_state);

CREATE INDEX IF NOT EXISTS idx_scv1_endpoint_state_observed
  ON signal_certificate_v1 (endpoint_state)
  WHERE endpoint_state = 'RESPONSE_OBSERVED';

CREATE INDEX IF NOT EXISTS idx_scv1_certificate_present
  ON signal_certificate_v1 (certificate_present)
  WHERE certificate_present IS NOT NULL;

-- Expiry analysis

CREATE INDEX IF NOT EXISTS idx_scv1_leaf_days_remaining
  ON signal_certificate_v1 (leaf_days_remaining)
  WHERE leaf_days_remaining IS NOT NULL;

-- Issuer distribution analysis

CREATE INDEX IF NOT EXISTS idx_scv1_leaf_issuer_cn
  ON signal_certificate_v1 (leaf_issuer_cn)
  WHERE leaf_issuer_cn IS NOT NULL;

-- Wildcard and self-signed analysis
-- Partial indexes on non-null values only (null = no SANs; excluded from population counts)

CREATE INDEX IF NOT EXISTS idx_scv1_leaf_is_wildcard
  ON signal_certificate_v1 (leaf_is_wildcard)
  WHERE leaf_is_wildcard IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scv1_leaf_is_self_signed
  ON signal_certificate_v1 (leaf_is_self_signed)
  WHERE leaf_is_self_signed IS NOT NULL;

-- Fingerprint lookup (certificate identity tracking)

CREATE INDEX IF NOT EXISTS idx_scv1_leaf_fingerprint_sha256
  ON signal_certificate_v1 (leaf_fingerprint_sha256)
  WHERE leaf_fingerprint_sha256 IS NOT NULL;

-- JSONB evidence — GIN index enables @>, jsonpath, and jsonb_path_query

CREATE INDEX IF NOT EXISTS idx_scv1_evidence_gin
  ON signal_certificate_v1 USING GIN (evidence);

-- ── Verification ──────────────────────────────────────────────────────────────

-- Run after applying to confirm structure:
--
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'signal_certificate_v1'
--  ORDER BY ordinal_position;
--
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE tablename = 'signal_certificate_v1';
--
-- Expected: 20 columns, 15 indexes.
-- Confirm leaf_is_wildcard IS NULLABLE (not NOT NULL).
-- Confirm evidence IS NOT NULL.
