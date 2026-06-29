-- Migration 016: SOT-TLS-001 — TLS Configuration Facts Signal
-- Table: signal_tls_v1
--
-- Authority:
--   SOT-TLS-001 v1.0 — Implementation Active
--   TLS_COLLECTION_DOMAIN_LAYER_IMPLEMENTATION.md v1.1
--   TLS Collection Domain Layer Conformance Review — Outcome B (2026-06-19)
--
-- Storage model:
--   ADR-SYS-006 (JSONB evidence blocks — v1 schema).
--   Full evidence block in 'evidence' JSONB column.
--   Selected scalar fields promoted to indexed columns per SOT-TLS-001 §4.5.
--   No scores, ratings, or interpretations stored.
--   JSONB structure matches the TLS Evidence Object from tls-extractor.js.
--
-- Category D collection model:
--   Per ADR-COL-003, SOT-TLS-001 and SOT-CERTIFICATE-001 share one TLS session per
--   domain per run. The TLS Evidence Extractor (tls-extractor.js) projects the
--   TLS-configuration fields from the shared TLS Session Evidence Object.
--   Certificate evidence is stored separately in signal_certificate_v1 (Migration 015).
--   Temporal correlation between the two tables is established via:
--     collected_at (same timestamp — same TLS session)
--     collection_hostname (same domain FQDN — same TLS session)
--
-- endpoint_state values (three-state; from TLS_LAYER_IMPL_001 §6):
--   RESPONSE_OBSERVED  — TLS handshake completed (TLS facts observable)
--   TLS_ERROR          — TCP connected; TLS handshake failed at protocol layer
--   CONNECTION_ERROR   — TCP connection could not be established
--
-- Nullable promoted column semantics (Conformance Review, Outcome B):
--
--   negotiated_version (text, nullable):
--     Non-null on RESPONSE_OBSERVED; null on TLS_ERROR and CONNECTION_ERROR.
--
--   cipher_suite_standard (text, nullable):
--     Non-null on RESPONSE_OBSERVED; null on TLS_ERROR and CONNECTION_ERROR.
--
--   forward_secrecy (boolean, nullable):
--     Null in two distinct cases:
--       (a) TLS_ERROR or CONNECTION_ERROR — handshake did not complete
--       (b) RESPONSE_OBSERVED with unrecognised TLS 1.2 cipher — key exchange
--           component not parseable; SI-002 null propagation applies
--     null ≠ false here. Null means "unknown", not "no forward secrecy".
--     Forward-secrecy COP calculations must exclude null from both numerator
--     and denominator (SOT-TLS-001 §7.3, conformance review C-2).
--     Do NOT add a NOT NULL constraint or a DEFAULT FALSE to this column.
--
--   cipher_key_exchange (text, nullable — informational index; not in §4.5 promoted list):
--     Null in the same two cases as forward_secrecy. Included for benchmarking.
--
--   alpn_protocol (text, nullable):
--     Null when ALPN was not negotiated on an otherwise RESPONSE_OBSERVED connection.
--     Null ≠ "not supported" — many servers do not send ALPN even when h2 is available.
--
--   http2_negotiated (boolean, nullable):
--     Null when alpn_protocol is null. False when alpn_protocol is non-null but not 'h2'.
--
-- Rerun strategy:
--   run_id groups all rows from a single TLS signal collection run.
--   (run_id, domain) is unique: prevents duplicate inserts within one run.
--   Multiple run_ids per domain are allowed: historical reruns are preserved.
--   Note: the Category D Runner generates separate run_ids for TLS (this table)
--   and Certificate (signal_certificate_v1) even though they share TLS sessions.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Idempotent: safe to run more than once.

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_tls_v1 (

  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            uuid        NOT NULL,
  domain            text        NOT NULL,
  collected_at      timestamptz NOT NULL,
  signal_version    text        NOT NULL,
  collector_version text        NOT NULL,

  -- ── Promoted scalar columns ────────────────────────────────────────────────
  -- Per SOT-TLS-001 §4.5. All nullable where the Layer may return null.

  -- Connection outcome (always present)
  endpoint_state          text        NOT NULL,

  -- TLS protocol version (null when TLS_ERROR or CONNECTION_ERROR)
  negotiated_version      text,

  -- RFC/IANA cipher suite name (null when TLS_ERROR or CONNECTION_ERROR)
  cipher_suite_standard   text,

  -- Forward secrecy indicator:
  --   null = unrecognised cipher OR non-RESPONSE_OBSERVED outcome (see rationale above)
  --   true = TLS 1.3 always; TLS 1.2 with ECDHE or DHE key exchange
  --   false = TLS 1.2 with RSA key exchange (no forward secrecy)
  --   DO NOT ADD NOT NULL OR DEFAULT FALSE — see nullable semantics note above.
  forward_secrecy         boolean,

  -- ALPN protocol string (null when not negotiated; not the same as "not supported")
  alpn_protocol           text,

  -- HTTP/2 indicator (null when alpn_protocol null; false when non-h2 ALPN)
  http2_negotiated        boolean,

  -- Cipher key exchange mechanism (informational; not in §4.5 but high benchmarking value)
  -- Values: 'TLS13' | 'ECDHE' | 'DHE' | 'RSA' | null
  -- Null has the same semantics as forward_secrecy — unrecognised cipher OR failure outcome.
  cipher_key_exchange     text,

  -- ── Full JSONB evidence block ──────────────────────────────────────────────
  -- Contains the complete TLS Evidence Object from tls-extractor.js.
  -- All fields from the TLS Session Evidence Object owned by SOT-TLS-001,
  -- plus shared context fields required to interpret the evidence.
  --
  -- Top-level structure:
  --   endpoint_state, collected_at, collection_hostname,
  --   connection_error_code, connection_error_msg,
  --   negotiated_version,
  --   cipher_suite_openssl, cipher_suite_standard,
  --   cipher_key_exchange, cipher_symmetric_alg, cipher_mac_hash,
  --   forward_secrecy,
  --   alpn_protocol, http2_negotiated,
  --   session_ticket_issued (null in v1),
  --   ocsp_stapling_present (null in v1),
  --   key_share_group (null in v1)
  evidence          jsonb       NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),

  -- ── Constraints ───────────────────────────────────────────────────────────

  CONSTRAINT stv1_endpoint_state_values CHECK (
    endpoint_state IN (
      'RESPONSE_OBSERVED',
      'TLS_ERROR',
      'CONNECTION_ERROR'
    )
  ),

  CONSTRAINT stv1_negotiated_version_values CHECK (
    negotiated_version IS NULL OR negotiated_version IN (
      'TLSv1.3', 'TLSv1.2', 'TLSv1.1', 'TLSv1', 'SSLv3'
    )
  ),

  CONSTRAINT stv1_cipher_key_exchange_values CHECK (
    cipher_key_exchange IS NULL OR cipher_key_exchange IN (
      'TLS13', 'ECDHE', 'DHE', 'RSA'
    )
  ),

  CONSTRAINT stv1_signal_version_non_empty CHECK (
    signal_version <> ''
  ),

  CONSTRAINT stv1_collector_version_non_empty CHECK (
    collector_version <> ''
  ),

  -- Unique per run: prevents re-inserting the same domain in the same run
  CONSTRAINT stv1_run_domain_unique UNIQUE (run_id, domain)

);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary access patterns

CREATE INDEX IF NOT EXISTS idx_stv1_domain
  ON signal_tls_v1 (domain);

CREATE INDEX IF NOT EXISTS idx_stv1_domain_collected_at
  ON signal_tls_v1 (domain, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_stv1_collected_at
  ON signal_tls_v1 (collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_stv1_run_id
  ON signal_tls_v1 (run_id);

-- State queries

CREATE INDEX IF NOT EXISTS idx_stv1_endpoint_state
  ON signal_tls_v1 (endpoint_state);

CREATE INDEX IF NOT EXISTS idx_stv1_endpoint_state_observed
  ON signal_tls_v1 (endpoint_state)
  WHERE endpoint_state = 'RESPONSE_OBSERVED';

-- TLS version distribution — primary benchmarking dimension

CREATE INDEX IF NOT EXISTS idx_stv1_negotiated_version
  ON signal_tls_v1 (negotiated_version)
  WHERE negotiated_version IS NOT NULL;

-- Forward secrecy analysis
-- Partial index on non-null values only (null = unrecognised cipher or failure; excluded from FS%)

CREATE INDEX IF NOT EXISTS idx_stv1_forward_secrecy
  ON signal_tls_v1 (forward_secrecy)
  WHERE forward_secrecy IS NOT NULL;

-- Cipher key exchange distribution

CREATE INDEX IF NOT EXISTS idx_stv1_cipher_key_exchange
  ON signal_tls_v1 (cipher_key_exchange)
  WHERE cipher_key_exchange IS NOT NULL;

-- ALPN / HTTP2 analysis

CREATE INDEX IF NOT EXISTS idx_stv1_alpn_protocol
  ON signal_tls_v1 (alpn_protocol)
  WHERE alpn_protocol IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stv1_http2_negotiated
  ON signal_tls_v1 (http2_negotiated)
  WHERE http2_negotiated IS NOT NULL;

-- JSONB evidence — GIN index enables @>, jsonpath, and jsonb_path_query

CREATE INDEX IF NOT EXISTS idx_stv1_evidence_gin
  ON signal_tls_v1 USING GIN (evidence);

-- ── Verification ──────────────────────────────────────────────────────────────

-- Run after applying to confirm structure:
--
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'signal_tls_v1'
--  ORDER BY ordinal_position;
--
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE tablename = 'signal_tls_v1';
--
-- Expected: 17 columns, 12 indexes.
-- Confirm forward_secrecy IS NULLABLE (not NOT NULL, not DEFAULT FALSE).
-- Confirm cipher_key_exchange IS NULLABLE.
-- Confirm evidence IS NOT NULL.
--
-- Key check — confirm forward_secrecy allows null for RESPONSE_OBSERVED:
--
-- SELECT
--   endpoint_state,
--   forward_secrecy,
--   COUNT(*) AS n
-- FROM signal_tls_v1
-- GROUP BY 1, 2
-- ORDER BY 1, 2;
--
-- Expected: RESPONSE_OBSERVED rows may appear with forward_secrecy = null
-- (unrecognised ciphers). This is correct and expected.
