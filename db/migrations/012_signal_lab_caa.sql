-- Migration 012: SOT-CAA-001 Signal Lab CAA table
--
-- Single DNS query per domain: CAA records at the apex.
-- No inheritance chain traversal. Observes only what is published at the
-- queried name; parent zone records are not collected.
--
-- DNS three-state presence model:
--   dns_caa_present = TRUE   -- DNS resolved; one or more CAA records found
--   dns_caa_present = FALSE  -- DNS resolved; no CAA records (genuinely absent)
--   dns_caa_present = NULL   -- DNS did not respond; presence unknown
--
-- Evidence model:
--   caa_records contains ALL CAA records returned, verbatim in DNS return order.
--   No records are discarded. Duplicates are preserved.
--   Unknown tags are preserved alongside standard tags.
--   Empty values (prohibiting CA issuance) are preserved verbatim.
--
-- Signal Lab principles enforced:
--   - No interpretation of CA authorization policy
--   - No assessment of policy completeness or strength
--   - No scores, ratings, or trust assessments stored
--   - Unknown DNS status codes mapped to DNS_FAILURE (not collapsed to absent)
--   - Absent tags stored as NULL; absent integers stored as NULL (not 0)

-- -----------------------------------------------------------------------------
-- Table: signal_facts_caa
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signal_facts_caa (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                 TEXT        NOT NULL,
  signal_version         INTEGER     NOT NULL DEFAULT 1,
  collected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── CAA presence: three-state ──────────────────────────────────────────────

  -- Three-state CAA presence (NULL = DNS collection failed)
  dns_caa_present        BOOLEAN,
  caa_collection_error   TEXT,

  -- ── Primary evidence ──────────────────────────────────────────────────────

  -- All CAA records returned, in DNS return order. No records discarded.
  -- Each element: { "flags": <int>, "tag": "<str>", "value": "<str>" }
  -- flags: raw 8-bit value (0–255); bit 0 (MSB, value 128) = issuer critical flag
  -- tag:   standard (issue, issuewild, iodef) or unknown
  -- value: verbatim; empty string is a valid and significant observation
  caa_records            JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Total count of CAA records returned (NULL if collection failed)
  caa_record_count       INTEGER,

  -- ── Derived observations: tag-specific counts ─────────────────────────────

  caa_issue_count        INTEGER,
  caa_issuewild_count    INTEGER,
  caa_iodef_count        INTEGER,
  caa_unknown_tag_count  INTEGER,   -- records with tag ∉ {issue, issuewild, iodef}
  caa_critical_count     INTEGER,   -- records where flags & 128 (issuer critical bit)

  -- ── Derived observations: value arrays ───────────────────────────────────

  -- Values from records of each standard tag type, in DNS return order.
  -- Not deduplicated. Verbatim from DNS.
  caa_issue_values       TEXT[]      NOT NULL DEFAULT '{}',
  caa_issuewild_values   TEXT[]      NOT NULL DEFAULT '{}',
  caa_iodef_values       TEXT[]      NOT NULL DEFAULT '{}',

  -- Distinct sorted tag names observed across all records.
  -- Enables efficient queries by tag presence without scanning JSONB.
  caa_tags_present       TEXT[]      NOT NULL DEFAULT '{}',

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- collection_error constrained to defined network failure codes
  CONSTRAINT sfca_caa_collection_error_values
    CHECK (
      caa_collection_error IN ('DNS_TIMEOUT', 'DNS_SERVFAIL', 'DNS_FAILURE')
      OR caa_collection_error IS NULL
    ),

  -- Record and derived counts cannot be negative
  CONSTRAINT sfca_caa_record_count_non_negative
    CHECK (caa_record_count IS NULL OR caa_record_count >= 0),

  CONSTRAINT sfca_caa_issue_count_non_negative
    CHECK (caa_issue_count IS NULL OR caa_issue_count >= 0),

  CONSTRAINT sfca_caa_issuewild_count_non_negative
    CHECK (caa_issuewild_count IS NULL OR caa_issuewild_count >= 0),

  CONSTRAINT sfca_caa_iodef_count_non_negative
    CHECK (caa_iodef_count IS NULL OR caa_iodef_count >= 0),

  CONSTRAINT sfca_caa_unknown_tag_count_non_negative
    CHECK (caa_unknown_tag_count IS NULL OR caa_unknown_tag_count >= 0),

  CONSTRAINT sfca_caa_critical_count_non_negative
    CHECK (caa_critical_count IS NULL OR caa_critical_count >= 0)
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_sfca_domain
  ON signal_facts_caa (domain);

CREATE INDEX IF NOT EXISTS idx_sfca_domain_collected_at
  ON signal_facts_caa (domain, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sfca_collected_at
  ON signal_facts_caa (collected_at DESC);

-- CAA presence queries
CREATE INDEX IF NOT EXISTS idx_sfca_dns_caa_present
  ON signal_facts_caa (dns_caa_present);

CREATE INDEX IF NOT EXISTS idx_sfca_caa_collection_error
  ON signal_facts_caa (caa_collection_error)
  WHERE caa_collection_error IS NOT NULL;

-- Tag type presence queries (partial indexes for efficient filtering)
CREATE INDEX IF NOT EXISTS idx_sfca_caa_has_issue
  ON signal_facts_caa (caa_issue_count)
  WHERE caa_issue_count > 0;

CREATE INDEX IF NOT EXISTS idx_sfca_caa_has_issuewild
  ON signal_facts_caa (caa_issuewild_count)
  WHERE caa_issuewild_count > 0;

CREATE INDEX IF NOT EXISTS idx_sfca_caa_has_iodef
  ON signal_facts_caa (caa_iodef_count)
  WHERE caa_iodef_count > 0;

CREATE INDEX IF NOT EXISTS idx_sfca_caa_has_unknown_tags
  ON signal_facts_caa (caa_unknown_tag_count)
  WHERE caa_unknown_tag_count > 0;

CREATE INDEX IF NOT EXISTS idx_sfca_caa_has_critical
  ON signal_facts_caa (caa_critical_count)
  WHERE caa_critical_count > 0;

-- GIN index for querying records by field values
CREATE INDEX IF NOT EXISTS idx_sfca_caa_records_gin
  ON signal_facts_caa USING GIN (caa_records);

-- GIN indexes for array queries
CREATE INDEX IF NOT EXISTS idx_sfca_caa_issue_values_gin
  ON signal_facts_caa USING GIN (caa_issue_values);

CREATE INDEX IF NOT EXISTS idx_sfca_caa_issuewild_values_gin
  ON signal_facts_caa USING GIN (caa_issuewild_values);

CREATE INDEX IF NOT EXISTS idx_sfca_caa_tags_present_gin
  ON signal_facts_caa USING GIN (caa_tags_present);
