-- Migration 008: SOT-DMARC-001 Signal Lab DMARC table
--
-- Single-table design (contrast with DKIM two-table design):
--   DMARC records are simple tag strings, not rich objects needing a child table.
--   All v=DMARC1 records found at _dmarc.<domain> are preserved in dmarc_records TEXT[].
--   Tags are parsed from dmarc_records[1] (SQL 1-indexed = first record in array).
--
-- Three-state presence model:
--   dmarc_present = TRUE   -- DNS resolved, at least one v=DMARC1 record found
--   dmarc_present = FALSE  -- DNS resolved, no v=DMARC1 record (genuinely absent)
--   dmarc_present = NULL   -- DNS did not respond; presence unknown
--
-- Signal Lab principles enforced:
--   - Absent tags stored as NULL (RFC defaults never applied)
--   - No scores, ratings, risk levels, or recommendations stored
--   - All observed records preserved; none discarded

-- -----------------------------------------------------------------------------
-- Table: signal_facts_dmarc
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signal_facts_dmarc (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                  TEXT        NOT NULL,
  signal_version          INTEGER     NOT NULL DEFAULT 1,
  collected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Three-state presence
  dmarc_present           BOOLEAN,
  dmarc_collection_error  TEXT,

  -- Evidence: all v=DMARC1 records returned by DNS, in DNS return order
  dmarc_records           TEXT[]      NOT NULL DEFAULT '{}',
  dmarc_record_count      INTEGER,
  dmarc_multiple_records  BOOLEAN,

  -- Parsing result for dmarc_records[1] (first record)
  dmarc_parse_success     BOOLEAN,
  dmarc_syntax_errors     JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Required tags (RFC 7489)
  dmarc_version           TEXT,                -- v= tag value (should be DMARC1)
  dmarc_policy            TEXT,                -- p= none / quarantine / reject

  -- Optional policy tags
  dmarc_subdomain_policy  TEXT,                -- sp= none / quarantine / reject
  dmarc_adkim             TEXT,                -- adkim= r / s
  dmarc_aspf              TEXT,                -- aspf= r / s
  dmarc_pct               INTEGER,             -- pct= 0-100

  -- Reporting tags (raw strings preserved — not validated URIs)
  dmarc_rua               TEXT,                -- rua= aggregate report URI list
  dmarc_ruf               TEXT,                -- ruf= forensic report URI list
  dmarc_rua_count         INTEGER     NOT NULL DEFAULT 0,
  dmarc_ruf_count         INTEGER     NOT NULL DEFAULT 0,
  dmarc_fo                TEXT,                -- fo= failure options (raw)
  dmarc_ri                INTEGER,             -- ri= reporting interval (seconds)
  dmarc_rf                TEXT,                -- rf= report format (raw)

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- collection_error is only populated when dmarc_present = NULL
  CONSTRAINT sfdr_collection_error_values
    CHECK (
      dmarc_collection_error IN ('DNS_TIMEOUT', 'DNS_SERVFAIL', 'DNS_FAILURE')
      OR dmarc_collection_error IS NULL
    ),

  -- Policy values are constrained to the RFC-defined set (stored lowercase)
  CONSTRAINT sfdr_policy_values
    CHECK (dmarc_policy IN ('none', 'quarantine', 'reject') OR dmarc_policy IS NULL),

  CONSTRAINT sfdr_subdomain_policy_values
    CHECK (dmarc_subdomain_policy IN ('none', 'quarantine', 'reject') OR dmarc_subdomain_policy IS NULL),

  CONSTRAINT sfdr_adkim_values
    CHECK (dmarc_adkim IN ('r', 's') OR dmarc_adkim IS NULL),

  CONSTRAINT sfdr_aspf_values
    CHECK (dmarc_aspf IN ('r', 's') OR dmarc_aspf IS NULL),

  CONSTRAINT sfdr_pct_range
    CHECK (dmarc_pct >= 0 AND dmarc_pct <= 100 OR dmarc_pct IS NULL)
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_sfdr_domain
  ON signal_facts_dmarc (domain);

CREATE INDEX IF NOT EXISTS idx_sfdr_dmarc_present
  ON signal_facts_dmarc (dmarc_present);

CREATE INDEX IF NOT EXISTS idx_sfdr_policy
  ON signal_facts_dmarc (dmarc_policy)
  WHERE dmarc_policy IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfdr_collection_error
  ON signal_facts_dmarc (dmarc_collection_error)
  WHERE dmarc_collection_error IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfdr_multiple_records
  ON signal_facts_dmarc (dmarc_multiple_records)
  WHERE dmarc_multiple_records = TRUE;

CREATE INDEX IF NOT EXISTS idx_sfdr_parse_success
  ON signal_facts_dmarc (dmarc_parse_success)
  WHERE dmarc_parse_success = FALSE;

CREATE INDEX IF NOT EXISTS idx_sfdr_collected_at
  ON signal_facts_dmarc (collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sfdr_records_gin
  ON signal_facts_dmarc USING GIN (dmarc_records);

CREATE INDEX IF NOT EXISTS idx_sfdr_syntax_errors_gin
  ON signal_facts_dmarc USING GIN (dmarc_syntax_errors);
