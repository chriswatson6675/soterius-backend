-- Migration 007: SOT-DKIM-001 Signal Lab DKIM tables
--
-- Two-table design:
--   signal_facts_dkim      -- one row per domain per collection run
--   signal_facts_dkim_keys -- one row per discovered selector per run
--
-- Schema enforces Signal Lab principles:
--   dkim_present is TRUE or NULL only (never FALSE)
--   dkim_collection_status is constrained to defined values

-- -----------------------------------------------------------------------------
-- Domain-level facts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signal_facts_dkim (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  domain                  TEXT        NOT NULL,
  signal_version          INTEGER     NOT NULL DEFAULT 1,
  collected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dkim_present            BOOLEAN,
  dkim_collection_status  TEXT,
  dkim_record_count       INTEGER,
  dkim_selectors_probed   TEXT[]      NOT NULL DEFAULT '{}',
  dkim_selectors_found    TEXT[]      NOT NULL DEFAULT '{}',
  dkim_probe_set_version  INTEGER     NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT signal_facts_dkim_present_check
    CHECK (dkim_present IS NULL OR dkim_present = TRUE),

  CONSTRAINT signal_facts_dkim_collection_status_check
    CHECK (
      dkim_collection_status IN ('NOT_DETECTED', 'DNS_TIMEOUT', 'DNS_SERVFAIL', 'DNS_FAILURE')
      OR dkim_collection_status IS NULL
    )
);

-- -----------------------------------------------------------------------------
-- Key-level facts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signal_facts_dkim_keys (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dkim_run_id         UUID        NOT NULL REFERENCES signal_facts_dkim(id) ON DELETE CASCADE,
  domain              TEXT        NOT NULL,
  collected_at        TIMESTAMPTZ NOT NULL,
  selector            TEXT        NOT NULL,
  raw_record          TEXT        NOT NULL,
  parse_success       BOOLEAN     NOT NULL DEFAULT FALSE,
  version             TEXT,
  key_type            TEXT,
  key_bits            INTEGER,
  public_key_present  BOOLEAN,
  hash_algorithms     TEXT[],
  service_type        TEXT[],
  flags               TEXT[],
  syntax_errors       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- Indexes -- signal_facts_dkim
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_sfd_domain
  ON signal_facts_dkim (domain);

CREATE INDEX IF NOT EXISTS idx_sfd_dkim_present
  ON signal_facts_dkim (dkim_present);

CREATE INDEX IF NOT EXISTS idx_sfd_collection_status
  ON signal_facts_dkim (dkim_collection_status)
  WHERE dkim_collection_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfd_probe_set_version
  ON signal_facts_dkim (dkim_probe_set_version);

CREATE INDEX IF NOT EXISTS idx_sfd_collected_at
  ON signal_facts_dkim (collected_at DESC);

-- -----------------------------------------------------------------------------
-- Indexes -- signal_facts_dkim_keys
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_sfdk_run_id
  ON signal_facts_dkim_keys (dkim_run_id);

CREATE INDEX IF NOT EXISTS idx_sfdk_domain
  ON signal_facts_dkim_keys (domain);

CREATE INDEX IF NOT EXISTS idx_sfdk_selector
  ON signal_facts_dkim_keys (selector);

CREATE INDEX IF NOT EXISTS idx_sfdk_key_type
  ON signal_facts_dkim_keys (key_type);

CREATE INDEX IF NOT EXISTS idx_sfdk_key_bits
  ON signal_facts_dkim_keys (key_bits)
  WHERE key_bits IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sfdk_public_key_present
  ON signal_facts_dkim_keys (public_key_present);

CREATE INDEX IF NOT EXISTS idx_sfdk_syntax_errors
  ON signal_facts_dkim_keys USING GIN (syntax_errors);
