-- ── Migration 006: Signal Lab — SPF Facts Table ──────────────────────────────
-- Creates signal_facts_spf to store observable SPF facts collected by the
-- Signal Lab SPF collector (signal_version = 1).
--
-- Design principles:
--   - One row per collection run per domain.
--   - Typed columns for every fact so SQL queries are direct (no JSON extraction).
--   - spf_syntax_errors stored as JSONB array: [{code, message}, ...].
--
-- Three-state spf_present model:
--   true  — DNS resolved and an SPF record was found
--   false — DNS resolved and no SPF record exists (includes NXDOMAIN/no TXT records)
--   null  — DNS did not respond reliably (timeout, SERVFAIL, etc.); result unknown
--
-- When spf_present IS NULL, collection-dependent columns are also NULL:
--   spf_record, spf_record_count, spf_parse_success, spf_mechanism,
--   spf_lookup_count, spf_multiple_records, spf_include_count
-- spf_syntax_errors remains an empty array (NOT NULL) in all states.
--
-- Apply via Supabase Dashboard → SQL Editor.
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS signal_facts_spf (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain               TEXT        NOT NULL,
  signal_version       INTEGER     NOT NULL DEFAULT 1,
  collected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── Observable facts ──────────────────────────────────────────────────────

  -- Three-state: true | false | null (see header for semantics)
  spf_present          BOOLEAN,

  -- Non-null only when collection failed with an uncertain DNS error
  -- Values: 'DNS_TIMEOUT' | 'DNS_SERVFAIL' | 'DNS_FAILURE'
  spf_collection_error TEXT,

  -- Complete raw SPF record as returned by DNS
  spf_record           TEXT,

  -- Total count of SPF TXT records found at the apex domain
  spf_record_count     INTEGER,

  -- True if the SPF record was parsed without throwing; null when no record
  spf_parse_success    BOOLEAN,

  -- Structured syntax errors detected in the SPF record
  spf_syntax_errors    JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Terminal all mechanism: '-all' | '~all' | '?all' | '+all'
  spf_mechanism        TEXT,

  -- Number of DNS lookups the SPF record requires (RFC 7208 max is 10)
  spf_lookup_count     INTEGER,

  -- True if spf_record_count > 1; null when spf_present is null
  spf_multiple_records BOOLEAN,

  -- Count of include: mechanisms in the SPF record
  spf_include_count    INTEGER,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_facts_spf_mechanism_check
    CHECK (spf_mechanism IN ('-all', '~all', '?all', '+all') OR spf_mechanism IS NULL),

  CONSTRAINT signal_facts_spf_collection_error_check
    CHECK (spf_collection_error IN ('DNS_TIMEOUT', 'DNS_SERVFAIL', 'DNS_FAILURE') OR spf_collection_error IS NULL)
);

-- Domain lookup (trend queries: all SPF observations for a given domain)
CREATE INDEX IF NOT EXISTS idx_signal_facts_spf_domain
  ON signal_facts_spf (domain);

-- Domain + time (most common query: history ordered by time for a domain)
CREATE INDEX IF NOT EXISTS idx_signal_facts_spf_domain_collected_at
  ON signal_facts_spf (domain, collected_at DESC);

-- Global time index (dataset-wide analysis windows)
CREATE INDEX IF NOT EXISTS idx_signal_facts_spf_collected_at
  ON signal_facts_spf (collected_at DESC);

-- Core fact columns
CREATE INDEX IF NOT EXISTS idx_signal_facts_spf_present
  ON signal_facts_spf (spf_present);

CREATE INDEX IF NOT EXISTS idx_signal_facts_spf_collection_error
  ON signal_facts_spf (spf_collection_error)
  WHERE spf_collection_error IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signal_facts_spf_mechanism
  ON signal_facts_spf (spf_mechanism);

CREATE INDEX IF NOT EXISTS idx_signal_facts_spf_record_count
  ON signal_facts_spf (spf_record_count);

CREATE INDEX IF NOT EXISTS idx_signal_facts_spf_multiple_records
  ON signal_facts_spf (spf_multiple_records);

-- GIN index on syntax errors for JSON-path queries
-- e.g. WHERE spf_syntax_errors @> '[{"code":"LOOKUP_LIMIT_EXCEEDED"}]'
CREATE INDEX IF NOT EXISTS idx_signal_facts_spf_syntax_errors
  ON signal_facts_spf USING GIN (spf_syntax_errors);

-- ── Verification queries (run after applying) ─────────────────────────────────

-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'signal_facts_spf'
--  ORDER BY ordinal_position;
