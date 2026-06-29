-- Migration 011: SOT-DNSSEC-001 Signal Lab DNSSEC table
--
-- Two independent collection points per domain:
--   1. DS records — queried from the parent zone (primary presence indicator)
--   2. DNSKEY records — queried from the domain zone (corroborating evidence)
--
-- DNS three-state presence model (applied independently to each collection point):
--   dns_ds_present = TRUE   -- DNS resolved; one or more DS records found
--   dns_ds_present = FALSE  -- DNS resolved; no DS records (genuinely absent)
--   dns_ds_present = NULL   -- DNS did not respond; presence unknown
--   (same three states for dns_dnskey_present)
--
-- Evidence model:
--   ds_records contains ALL DS records returned at the parent zone, verbatim.
--   dnskey_records contains ALL DNSKEY records returned at the domain zone, verbatim.
--   DNS return order is preserved; no records are discarded.
--   Public key material is preserved in full inside dnskey_records JSONB.
--   dnskey_key_tags are Derived Observations computed per RFC 4034 Appendix B;
--   they are not directly observed from the DNS wire.
--
-- Signal Lab principles enforced:
--   - Absent tags stored as NULL (no RFC defaults applied)
--   - No DNSSEC validation performed; no chain-of-trust verification
--   - No scores, ratings, or trust assessments stored
--   - No RRSIG or NSEC/NSEC3 collection (v1 scope)
--   - Unknown DNS status codes mapped to DNS_FAILURE (not collapsed to absent)

-- -----------------------------------------------------------------------------
-- Table: signal_facts_dnssec
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signal_facts_dnssec (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                     TEXT        NOT NULL,
  signal_version             INTEGER     NOT NULL DEFAULT 1,
  collected_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── DS records: queried from the parent zone ─────────────────────────────────

  -- Three-state DS presence (NULL = DNS collection failed)
  dns_ds_present             BOOLEAN,
  ds_collection_error        TEXT,

  -- Evidence: all DS records returned, in DNS return order
  -- Each element: { key_tag, algorithm, digest_type, digest }
  ds_records                 JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Total count of DS records returned (NULL if collection failed)
  ds_record_count            INTEGER,

  -- Derived observations from the DS record set
  ds_algorithms              INTEGER[]   NOT NULL DEFAULT '{}',
  ds_digest_types            INTEGER[]   NOT NULL DEFAULT '{}',
  -- All key tags in DNS return order; not deduplicated
  ds_key_tags                INTEGER[]   NOT NULL DEFAULT '{}',

  -- ── DNSKEY records: queried from the domain zone ──────────────────────────────

  -- Three-state DNSKEY presence (NULL = DNS collection failed)
  dns_dnskey_present         BOOLEAN,
  dnskey_collection_error    TEXT,

  -- Evidence: all DNSKEY records returned, in DNS return order
  -- Each element: { flags, protocol, algorithm, public_key }
  -- public_key is stored verbatim as returned by the DoH resolver
  dnskey_records             JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- Total count of DNSKEY records returned (NULL if collection failed)
  dnskey_record_count        INTEGER,

  -- Derived observations from the DNSKEY record set
  -- Flags 257 = KSK (SEP bit set), 256 = ZSK
  dnskey_ksk_count           INTEGER,
  dnskey_zsk_count           INTEGER,
  dnskey_other_flags_count   INTEGER,
  dnskey_algorithms          INTEGER[]   NOT NULL DEFAULT '{}',
  -- Key tags in DNS return order; computed per RFC 4034 Appendix B
  dnskey_key_tags            INTEGER[]   NOT NULL DEFAULT '{}',

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- collection_error constrained to defined network failure codes
  CONSTRAINT sfdn_ds_collection_error_values
    CHECK (
      ds_collection_error IN ('DNS_TIMEOUT', 'DNS_SERVFAIL', 'DNS_FAILURE')
      OR ds_collection_error IS NULL
    ),

  CONSTRAINT sfdn_dnskey_collection_error_values
    CHECK (
      dnskey_collection_error IN ('DNS_TIMEOUT', 'DNS_SERVFAIL', 'DNS_FAILURE')
      OR dnskey_collection_error IS NULL
    ),

  -- Record counts cannot be negative
  CONSTRAINT sfdn_ds_record_count_non_negative
    CHECK (ds_record_count IS NULL OR ds_record_count >= 0),

  CONSTRAINT sfdn_dnskey_record_count_non_negative
    CHECK (dnskey_record_count IS NULL OR dnskey_record_count >= 0),

  CONSTRAINT sfdn_dnskey_ksk_count_non_negative
    CHECK (dnskey_ksk_count IS NULL OR dnskey_ksk_count >= 0),

  CONSTRAINT sfdn_dnskey_zsk_count_non_negative
    CHECK (dnskey_zsk_count IS NULL OR dnskey_zsk_count >= 0),

  CONSTRAINT sfdn_dnskey_other_flags_non_negative
    CHECK (dnskey_other_flags_count IS NULL OR dnskey_other_flags_count >= 0)
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_sfdn_domain
  ON signal_facts_dnssec (domain);

CREATE INDEX IF NOT EXISTS idx_sfdn_domain_collected_at
  ON signal_facts_dnssec (domain, collected_at DESC);

CREATE INDEX IF NOT EXISTS idx_sfdn_collected_at
  ON signal_facts_dnssec (collected_at DESC);

-- DS presence queries
CREATE INDEX IF NOT EXISTS idx_sfdn_dns_ds_present
  ON signal_facts_dnssec (dns_ds_present);

CREATE INDEX IF NOT EXISTS idx_sfdn_ds_collection_error
  ON signal_facts_dnssec (ds_collection_error)
  WHERE ds_collection_error IS NOT NULL;

-- DNSKEY presence queries
CREATE INDEX IF NOT EXISTS idx_sfdn_dns_dnskey_present
  ON signal_facts_dnssec (dns_dnskey_present);

CREATE INDEX IF NOT EXISTS idx_sfdn_dnskey_collection_error
  ON signal_facts_dnssec (dnskey_collection_error)
  WHERE dnskey_collection_error IS NOT NULL;

-- Algorithm and digest type queries
CREATE INDEX IF NOT EXISTS idx_sfdn_ds_algorithms
  ON signal_facts_dnssec USING GIN (ds_algorithms);

CREATE INDEX IF NOT EXISTS idx_sfdn_ds_digest_types
  ON signal_facts_dnssec USING GIN (ds_digest_types);

CREATE INDEX IF NOT EXISTS idx_sfdn_dnskey_algorithms
  ON signal_facts_dnssec USING GIN (dnskey_algorithms);

-- KSK/ZSK count queries
CREATE INDEX IF NOT EXISTS idx_sfdn_dnskey_ksk_count
  ON signal_facts_dnssec (dnskey_ksk_count)
  WHERE dnskey_ksk_count > 0;

CREATE INDEX IF NOT EXISTS idx_sfdn_dnskey_zsk_count
  ON signal_facts_dnssec (dnskey_zsk_count)
  WHERE dnskey_zsk_count > 0;

-- GIN indexes for JSONB evidence columns
CREATE INDEX IF NOT EXISTS idx_sfdn_ds_records_gin
  ON signal_facts_dnssec USING GIN (ds_records);

CREATE INDEX IF NOT EXISTS idx_sfdn_dnskey_records_gin
  ON signal_facts_dnssec USING GIN (dnskey_records);
