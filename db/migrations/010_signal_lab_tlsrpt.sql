-- Migration 010: SOT-TLSRPT-001 Signal Lab TLS Reporting table
--
-- Single DNS-query signal (contrast with MTA-STS which requires DNS + HTTPS).
-- Queries _tlsrpt.<domain> for TXT records containing v=TLSRPTv1.
--
-- DNS three-state presence model:
--   dns_tlsrpt_present = TRUE   -- DNS resolved; at least one v=TLSRPTv1 record found
--   dns_tlsrpt_present = FALSE  -- DNS resolved; no v=TLSRPTv1 record (genuinely absent)
--   dns_tlsrpt_present = NULL   -- DNS did not respond; presence unknown
--
-- Evidence model:
--   dns_records contains ALL TXT records returned at _tlsrpt.<domain>, verbatim.
--   dns_record_count is the total TXT record count.
--   dns_tlsrpt_record_count counts only records bearing v=TLSRPTv1.
--   When multiple qualifying records exist, all are preserved and the first is parsed.
--   rua_raw is the verbatim rua= tag value before URI splitting.
--   rua_uris is the split URI list in document order.
--   Unknown DNS tags are preserved verbatim in dns_unknown_tags.
--
-- Signal Lab principles enforced:
--   - Absent tags stored as NULL (RFC defaults never applied)
--   - No scores, ratings, risk levels, or recommendations stored
--   - All observed DNS records preserved; none discarded
--   - URI order preserved as observed
--   - Unknown tags preserved as evidence

-- -----------------------------------------------------------------------------
-- Table: signal_facts_tlsrpt
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signal_facts_tlsrpt (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                     TEXT        NOT NULL,
  signal_version             INTEGER     NOT NULL DEFAULT 1,
  collected_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── DNS collection: _tlsrpt.<domain> ────────────────────────────────────────

  -- Three-state presence (NULL = DNS collection failed)
  dns_tlsrpt_present         BOOLEAN,
  dns_collection_error       TEXT,

  -- Evidence: all TXT records returned at _tlsrpt.<domain>, in DNS return order
  dns_records                TEXT[]      NOT NULL DEFAULT '{}',

  -- Total count of TXT records returned (regardless of v=TLSRPTv1 content)
  dns_record_count           INTEGER,

  -- Count of records containing v=TLSRPTv1
  dns_tlsrpt_record_count    INTEGER,

  -- TRUE when more than one v=TLSRPTv1 record is present (RFC 8460 §3 violation)
  dns_multiple_tlsrpt_records BOOLEAN,

  -- ── Parsing: applied to the first qualifying v=TLSRPTv1 record ──────────────

  dns_parse_success          BOOLEAN,
  dns_syntax_errors          JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- RFC 8460 §3 defines only v= and rua= tags
  dns_version                TEXT,                -- v= tag value (expected: TLSRPTv1)
  dns_unknown_tags           JSONB       NOT NULL DEFAULT '{}'::jsonb,

  -- ── RUA field: aggregate reporting URI list ──────────────────────────────────

  -- Verbatim rua= tag value; NULL when tag is absent, '' when tag is empty
  rua_raw                    TEXT,

  -- Parsed URI list in document order; verbatim, no normalisation
  rua_uris                   TEXT[]      NOT NULL DEFAULT '{}',

  -- URI counts
  rua_count                  INTEGER     NOT NULL DEFAULT 0,
  rua_mailto_count            INTEGER     NOT NULL DEFAULT 0,
  rua_https_count             INTEGER     NOT NULL DEFAULT 0,
  rua_unknown_scheme_count    INTEGER     NOT NULL DEFAULT 0,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- DNS collection_error constrained to defined network failure codes
  CONSTRAINT sftr_dns_collection_error_values
    CHECK (
      dns_collection_error IN ('DNS_TIMEOUT', 'DNS_SERVFAIL', 'DNS_FAILURE')
      OR dns_collection_error IS NULL
    ),

  -- URI counts cannot be negative
  CONSTRAINT sftr_rua_count_range
    CHECK (rua_count >= 0),

  CONSTRAINT sftr_rua_mailto_count_range
    CHECK (rua_mailto_count >= 0),

  CONSTRAINT sftr_rua_https_count_range
    CHECK (rua_https_count >= 0),

  CONSTRAINT sftr_rua_unknown_scheme_count_range
    CHECK (rua_unknown_scheme_count >= 0)
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_sftr_domain
  ON signal_facts_tlsrpt (domain);

CREATE INDEX IF NOT EXISTS idx_sftr_domain_collected_at
  ON signal_facts_tlsrpt (domain, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sftr_collected_at
  ON signal_facts_tlsrpt (collected_at DESC);

-- DNS presence queries
CREATE INDEX IF NOT EXISTS idx_sftr_dns_tlsrpt_present
  ON signal_facts_tlsrpt (dns_tlsrpt_present);

CREATE INDEX IF NOT EXISTS idx_sftr_dns_collection_error
  ON signal_facts_tlsrpt (dns_collection_error)
  WHERE dns_collection_error IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sftr_dns_multiple_tlsrpt_records
  ON signal_facts_tlsrpt (dns_multiple_tlsrpt_records)
  WHERE dns_multiple_tlsrpt_records = TRUE;

CREATE INDEX IF NOT EXISTS idx_sftr_dns_parse_success
  ON signal_facts_tlsrpt (dns_parse_success)
  WHERE dns_parse_success = FALSE;

-- RUA analysis queries
CREATE INDEX IF NOT EXISTS idx_sftr_rua_count
  ON signal_facts_tlsrpt (rua_count)
  WHERE rua_count > 0;

CREATE INDEX IF NOT EXISTS idx_sftr_rua_mailto_count
  ON signal_facts_tlsrpt (rua_mailto_count)
  WHERE rua_mailto_count > 0;

CREATE INDEX IF NOT EXISTS idx_sftr_rua_https_count
  ON signal_facts_tlsrpt (rua_https_count)
  WHERE rua_https_count > 0;

CREATE INDEX IF NOT EXISTS idx_sftr_rua_unknown_scheme
  ON signal_facts_tlsrpt (rua_unknown_scheme_count)
  WHERE rua_unknown_scheme_count > 0;

-- GIN indexes for array and JSONB evidence columns
CREATE INDEX IF NOT EXISTS idx_sftr_dns_records_gin
  ON signal_facts_tlsrpt USING GIN (dns_records);

CREATE INDEX IF NOT EXISTS idx_sftr_dns_syntax_errors_gin
  ON signal_facts_tlsrpt USING GIN (dns_syntax_errors);

CREATE INDEX IF NOT EXISTS idx_sftr_rua_uris_gin
  ON signal_facts_tlsrpt USING GIN (rua_uris);
