-- Migration 014: SOT-SECURITYHEADERS-001 — HTTP Security Headers Signal
-- Table: signal_securityheaders_v1
--
-- Storage model:
--   Single evidence-preserving table. All collector output stored verbatim.
--   No flattening of JSONB evidence. No scores, ratings, or interpretations.
--   JSONB structures match the frozen SOT-SECURITYHEADERS-001 v1 schema exactly.
--
-- Evidence model:
--   https_fetch       — HttpsFetchResult (follows redirects; header_pairs preserved)
--   http_probe        — HttpProbeFetchResult (single non-following request)
--   header_inventory  — SecurityHeaderInventory (25 named HeaderObservation fields)
--
-- endpoint_state values (from SOT-SECURITYHEADERS-001 v1 FetchOutcome enum):
--   RESPONSE_OBSERVED    — HTTP response received (any status code)
--   TLS_ERROR            — TLS/certificate failure during HTTPS handshake
--   CONNECTION_ERROR     — TCP-level connection failure (ECONNREFUSED, ENOTFOUND, etc.)
--   TIMEOUT              — Request exceeded TIMEOUT_MS (10 000 ms)
--   REDIRECT_UNRESOLVED  — Redirect chain exceeded MAX_REDIRECTS (10) or had no Location
--
-- endpoint_state mirrors https_fetch.fetch_outcome.
-- http_probe_state mirrors http_probe.fetch_outcome.
--
-- https_fetch JSONB structure:
--   { url, fetch_outcome, http_status, redirect_chain[],
--     header_pairs[{name_raw, value_raw, position}] }
--
-- http_probe JSONB structure:
--   { url, fetch_outcome, http_status, redirect_chain: [],
--     header_pairs[{name_raw, value_raw, position}] }
--   redirect_chain is always [] (probe never follows redirects)
--
-- header_inventory JSONB structure:
--   25 named fields, each: { present, count, values[], first_position }
--   Populated from https_fetch.header_pairs only.
--   All fields present and absent (present:false) when endpoint_state != RESPONSE_OBSERVED.
--
-- Rerun strategy:
--   run_id groups all rows from a single cohort run.
--   (run_id, domain) is unique: prevents duplicate inserts within one run.
--   Multiple run_ids per domain are allowed: historical reruns are preserved.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Idempotent: safe to run more than once.

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_securityheaders_v1 (

  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            uuid        NOT NULL,
  domain            text        NOT NULL,
  collected_at      timestamptz NOT NULL,
  signal_version    text        NOT NULL,
  collector_version text        NOT NULL,

  -- endpoint_state mirrors https_fetch.fetch_outcome
  endpoint_state    text        NOT NULL,

  -- http_probe_state mirrors http_probe.fetch_outcome
  http_probe_state  text        NOT NULL,

  -- ── Full evidence blocks (JSONB) ───────────────────────────────────────────

  -- HttpsFetchResult: follows redirects up to MAX_REDIRECTS=10
  -- { url, fetch_outcome, http_status, redirect_chain[],
  --   header_pairs[{name_raw, value_raw, position}] }
  https_fetch       jsonb       NOT NULL,

  -- HttpProbeFetchResult: single non-following request
  -- { url, fetch_outcome, http_status, redirect_chain: [],
  --   header_pairs[{name_raw, value_raw, position}] }
  http_probe        jsonb       NOT NULL,

  -- SecurityHeaderInventory: 25 named HeaderObservation fields
  -- { strict_transport_security, content_security_policy, ...,
  --   each: { present, count, values[], first_position } }
  header_inventory  jsonb       NOT NULL,

  created_at        timestamptz NOT NULL DEFAULT now(),

  -- ── Constraints ───────────────────────────────────────────────────────────

  CONSTRAINT sshv1_endpoint_state_values CHECK (
    endpoint_state IN (
      'RESPONSE_OBSERVED',
      'TLS_ERROR',
      'CONNECTION_ERROR',
      'TIMEOUT',
      'REDIRECT_UNRESOLVED'
    )
  ),

  CONSTRAINT sshv1_http_probe_state_values CHECK (
    http_probe_state IN (
      'RESPONSE_OBSERVED',
      'TLS_ERROR',
      'CONNECTION_ERROR',
      'TIMEOUT',
      'REDIRECT_UNRESOLVED'
    )
  ),

  CONSTRAINT sshv1_signal_version_non_empty CHECK (
    signal_version <> ''
  ),

  CONSTRAINT sshv1_collector_version_non_empty CHECK (
    collector_version <> ''
  ),

  -- Unique per run: prevents re-inserting the same domain in the same run
  CONSTRAINT sshv1_run_domain_unique UNIQUE (run_id, domain)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary access patterns

CREATE INDEX IF NOT EXISTS idx_sshv1_domain
  ON signal_securityheaders_v1 (domain);

CREATE INDEX IF NOT EXISTS idx_sshv1_domain_collected_at
  ON signal_securityheaders_v1 (domain, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sshv1_collected_at
  ON signal_securityheaders_v1 (collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sshv1_run_id
  ON signal_securityheaders_v1 (run_id);

-- State queries

CREATE INDEX IF NOT EXISTS idx_sshv1_endpoint_state
  ON signal_securityheaders_v1 (endpoint_state);

CREATE INDEX IF NOT EXISTS idx_sshv1_endpoint_state_observed
  ON signal_securityheaders_v1 (endpoint_state)
  WHERE endpoint_state = 'RESPONSE_OBSERVED';

-- JSONB evidence — GIN indexes enable @>, jsonpath, and jsonb_path_query

CREATE INDEX IF NOT EXISTS idx_sshv1_https_fetch_gin
  ON signal_securityheaders_v1 USING GIN (https_fetch);

CREATE INDEX IF NOT EXISTS idx_sshv1_http_probe_gin
  ON signal_securityheaders_v1 USING GIN (http_probe);

CREATE INDEX IF NOT EXISTS idx_sshv1_header_inventory_gin
  ON signal_securityheaders_v1 USING GIN (header_inventory);

-- ── Verification ──────────────────────────────────────────────────────────────

-- Run after applying to confirm structure:
--
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'signal_securityheaders_v1'
--  ORDER BY ordinal_position;
--
-- SELECT indexname, indexdef
--   FROM pg_indexes
--  WHERE tablename = 'signal_securityheaders_v1';
