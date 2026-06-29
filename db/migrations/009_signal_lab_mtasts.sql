-- Migration 009: SOT-MTASTS-001 Signal Lab MTA-STS table
--
-- Two-layer observation model (contrast with single-layer SPF/DMARC):
--   MTA-STS requires both a DNS TXT record and an HTTPS-hosted policy file.
--   Each layer is independently observable and can independently succeed or fail.
--   All dns_ columns record the _mta-sts.<domain> TXT observation.
--   All policy_ columns record the https://mta-sts.<domain>/.well-known/mta-sts.txt observation.
--
-- DNS three-state presence model (same as DMARC):
--   dns_sts_present = TRUE   -- DNS resolved; at least one v=STSv1 record found
--   dns_sts_present = FALSE  -- DNS resolved; no v=STSv1 record (genuinely absent)
--   dns_sts_present = NULL   -- DNS did not respond; presence unknown
--
-- HTTPS three-state presence model:
--   policy_present = TRUE    -- HTTP 2xx response with body received
--   policy_present = FALSE   -- HTTP response received but non-2xx (policy absent)
--   policy_present = NULL    -- HTTPS connection failed; policy existence unknown
--
-- Two-pass TLS retrieval model:
--   policy_tls_valid records whether the TLS certificate was valid (Pass 1).
--   If Pass 1 fails with a certificate error (not a handshake failure),
--   Pass 2 retrieves the body without certificate validation.
--   policy_body_tls_validated = FALSE when body was collected via Pass 2.
--   Pass 1 TLS observations (policy_tls_valid, policy_tls_error) are NEVER
--   overwritten by Pass 2.
--
-- Signal Lab principles enforced:
--   - Absent tags/fields stored as NULL (RFC defaults never applied)
--   - No scores, ratings, risk levels, or recommendations stored
--   - All observed DNS records preserved; none discarded
--   - Raw policy body preserved verbatim
--   - Unknown DNS tags and unknown policy fields preserved as evidence

-- -----------------------------------------------------------------------------
-- Table: signal_facts_mtasts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signal_facts_mtasts (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                     TEXT        NOT NULL,
  signal_version             INTEGER     NOT NULL DEFAULT 1,
  collected_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── DNS group: _mta-sts.<domain> ─────────────────────────────────────────

  -- Three-state presence (NULL = DNS collection failed)
  dns_sts_present            BOOLEAN,
  dns_collection_error       TEXT,

  -- Evidence: all v=STSv1 records returned by DNS, in DNS return order
  dns_records                TEXT[]      NOT NULL DEFAULT '{}',
  dns_record_count           INTEGER,
  dns_sts_record_count       INTEGER,
  dns_multiple_sts_records   BOOLEAN,

  -- Parsing result for dns_records[1] (first v=STSv1 record; SQL 1-indexed)
  dns_parse_success          BOOLEAN,
  dns_syntax_errors          JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Parsed tags (RFC 8461 defines only v= and id=)
  dns_version                TEXT,                -- v= tag value (expected: STSv1)
  dns_id                     TEXT,                -- id= tag value (cache-busting key)
  dns_unknown_tags           JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- ── HTTPS group: https://mta-sts.<domain>/.well-known/mta-sts.txt ────────

  -- Whether the HTTPS fetch was attempted
  policy_fetch_attempted     BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Three-state presence (NULL = HTTPS connection failed)
  policy_present             BOOLEAN,
  policy_fetch_error         TEXT,

  -- HTTP-layer observations (from the response, if any)
  policy_http_status         INTEGER,
  policy_tls_valid           BOOLEAN,
  policy_tls_error           TEXT,
  policy_redirect_count      INTEGER     NOT NULL DEFAULT 0,
  policy_content_type        TEXT,

  -- Evidence: raw response body preserved verbatim
  -- NULL when no response received; empty string if 200 with empty body
  policy_body_raw            TEXT,

  -- Whether the body was collected over a validated TLS connection
  -- TRUE  = body from Pass 1 (validated TLS)
  -- FALSE = body from Pass 2 (non-validating, after certificate error)
  -- NULL  = no body collected
  policy_body_tls_validated  BOOLEAN,

  -- Parsing result for policy_body_raw
  policy_parse_success       BOOLEAN,
  policy_syntax_errors       JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Parsed fields from the policy file (RFC 8461 §3.2)
  policy_version             TEXT,                -- version: field value
  policy_mode                TEXT,                -- mode: enforce / testing / none
  policy_max_age             INTEGER,             -- max_age: field value (seconds)
  policy_mx_patterns         TEXT[]      NOT NULL DEFAULT '{}',
  policy_mx_count            INTEGER     NOT NULL DEFAULT 0,
  policy_unknown_fields      JSONB       NOT NULL DEFAULT '{}'::jsonb,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- DNS collection_error only when dns_sts_present IS NULL
  CONSTRAINT sfms_dns_collection_error_values
    CHECK (
      dns_collection_error IN ('DNS_TIMEOUT', 'DNS_SERVFAIL', 'DNS_FAILURE')
      OR dns_collection_error IS NULL
    ),

  -- Policy mode constrained to RFC 8461 §3.2 values (stored lowercase)
  CONSTRAINT sfms_policy_mode_values
    CHECK (policy_mode IN ('enforce', 'testing', 'none') OR policy_mode IS NULL),

  -- max_age cannot be negative
  CONSTRAINT sfms_policy_max_age_range
    CHECK (policy_max_age >= 0 OR policy_max_age IS NULL),

  -- HTTP status must be a valid HTTP status code
  CONSTRAINT sfms_policy_http_status_range
    CHECK (policy_http_status >= 100 AND policy_http_status < 600 OR policy_http_status IS NULL),

  -- policy_fetch_error constrained to defined network failure codes
  CONSTRAINT sfms_policy_fetch_error_values
    CHECK (
      policy_fetch_error IN ('CONNECTION_TIMEOUT', 'CONNECTION_REFUSED', 'DNS_ERROR')
      OR policy_fetch_error IS NULL
    ),

  -- policy_tls_error constrained to defined TLS failure codes
  CONSTRAINT sfms_policy_tls_error_values
    CHECK (
      policy_tls_error IN (
        'CERT_EXPIRED',
        'CERT_HOSTNAME_MISMATCH',
        'CERT_UNTRUSTED',
        'CERT_SELF_SIGNED',
        'TLS_HANDSHAKE_FAILURE'
      )
      OR policy_tls_error IS NULL
    )
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_sfms_domain
  ON signal_facts_mtasts (domain);

CREATE INDEX IF NOT EXISTS idx_sfms_domain_collected_at
  ON signal_facts_mtasts (domain, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sfms_collected_at
  ON signal_facts_mtasts (collected_at DESC);

-- DNS presence queries
CREATE INDEX IF NOT EXISTS idx_sfms_dns_sts_present
  ON signal_facts_mtasts (dns_sts_present);

CREATE INDEX IF NOT EXISTS idx_sfms_dns_collection_error
  ON signal_facts_mtasts (dns_collection_error)
  WHERE dns_collection_error IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfms_dns_multiple_sts_records
  ON signal_facts_mtasts (dns_multiple_sts_records)
  WHERE dns_multiple_sts_records = TRUE;

CREATE INDEX IF NOT EXISTS idx_sfms_dns_parse_success
  ON signal_facts_mtasts (dns_parse_success)
  WHERE dns_parse_success = FALSE;

-- dns_id: analysing cache-busting key changes over time
CREATE INDEX IF NOT EXISTS idx_sfms_dns_id
  ON signal_facts_mtasts (dns_id)
  WHERE dns_id IS NOT NULL;

-- Policy presence queries
CREATE INDEX IF NOT EXISTS idx_sfms_policy_present
  ON signal_facts_mtasts (policy_present);

CREATE INDEX IF NOT EXISTS idx_sfms_policy_mode
  ON signal_facts_mtasts (policy_mode)
  WHERE policy_mode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfms_policy_fetch_error
  ON signal_facts_mtasts (policy_fetch_error)
  WHERE policy_fetch_error IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfms_policy_tls_valid
  ON signal_facts_mtasts (policy_tls_valid)
  WHERE policy_tls_valid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfms_policy_tls_error
  ON signal_facts_mtasts (policy_tls_error)
  WHERE policy_tls_error IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfms_policy_http_status
  ON signal_facts_mtasts (policy_http_status)
  WHERE policy_http_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfms_policy_body_tls_validated
  ON signal_facts_mtasts (policy_body_tls_validated)
  WHERE policy_body_tls_validated IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfms_policy_parse_success
  ON signal_facts_mtasts (policy_parse_success)
  WHERE policy_parse_success = FALSE;

-- GIN indexes for array and JSONB evidence columns
CREATE INDEX IF NOT EXISTS idx_sfms_dns_records_gin
  ON signal_facts_mtasts USING GIN (dns_records);

CREATE INDEX IF NOT EXISTS idx_sfms_dns_syntax_errors_gin
  ON signal_facts_mtasts USING GIN (dns_syntax_errors);

CREATE INDEX IF NOT EXISTS idx_sfms_policy_mx_patterns_gin
  ON signal_facts_mtasts USING GIN (policy_mx_patterns);

CREATE INDEX IF NOT EXISTS idx_sfms_policy_syntax_errors_gin
  ON signal_facts_mtasts USING GIN (policy_syntax_errors);
