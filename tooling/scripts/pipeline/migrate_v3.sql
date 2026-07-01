-- Research Pipeline V3 — Schema Freeze Migration
--
-- Combines:
--   - Cohorts table (benchmark cohort registry)
--   - Seven critical dataset fields (DATASET_SCHEMA_V1_REVIEW.md)
--   - Postcode provenance tracking (ENRICHMENT_STRATEGY_V1.md)
--
-- Apply in Supabase Dashboard → SQL Editor after migrate_v2.sql.
-- This migration is idempotent: safe to run more than once.
--
-- After this migration the dataset schema is considered frozen for V1 collection.

-- ── Cohorts table ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cohorts (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_code             TEXT        NOT NULL UNIQUE,
  name                    TEXT        NOT NULL,
  sector                  TEXT        NOT NULL,
  region                  TEXT        NOT NULL,
  target_size             INTEGER,
  data_sources            TEXT[],
  defined_at              DATE        NOT NULL DEFAULT CURRENT_DATE,
  collection_started_at   DATE,
  collection_closed_at    DATE,
  notes                   TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Seed: Cohort 001 — North Wales Solicitors (closed, 35 validated firms)
INSERT INTO cohorts (
  cohort_code, name, sector, region, target_size, data_sources,
  defined_at, collection_started_at, collection_closed_at, notes
) VALUES (
  '001',
  'North Wales Solicitors',
  'solicitors',
  'North Wales',
  71,
  ARRAY['sra-register', 'google-maps'],
  '2026-06-01',
  '2026-06-01',
  '2026-06-14',
  'Proof-of-concept cohort. 35 validated firms after curation. Avg score 579/999. See BENCHMARK_REPORT_001.md.'
)
ON CONFLICT (cohort_code) DO NOTHING;

-- ── Critical dataset fields ────────────────────────────────────────────────────

ALTER TABLE prospects
  -- Cohort membership
  ADD COLUMN IF NOT EXISTS cohort_id              UUID        REFERENCES cohorts(id),
  -- Regulatory identity
  ADD COLUMN IF NOT EXISTS regulator              TEXT,
  ADD COLUMN IF NOT EXISTS regulator_id           TEXT,
  -- Structured geography
  ADD COLUMN IF NOT EXISTS postcode               TEXT,
  ADD COLUMN IF NOT EXISTS town                   TEXT,
  ADD COLUMN IF NOT EXISTS county                 TEXT,
  ADD COLUMN IF NOT EXISTS country                TEXT,
  -- Postcode provenance
  ADD COLUMN IF NOT EXISTS postcode_source        TEXT,
  ADD COLUMN IF NOT EXISTS postcode_confidence    INTEGER,
  -- Firm lifecycle
  ADD COLUMN IF NOT EXISTS active_status          TEXT        DEFAULT 'active',
  -- Longitudinal anchors
  ADD COLUMN IF NOT EXISTS first_discovered_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_scanned_at       TIMESTAMPTZ,
  -- Scan telemetry
  ADD COLUMN IF NOT EXISTS scan_count             INTEGER     DEFAULT 0;

-- ── Indexes ────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_prospects_cohort_id          ON prospects (cohort_id);
CREATE INDEX IF NOT EXISTS idx_prospects_regulator          ON prospects (regulator);
CREATE INDEX IF NOT EXISTS idx_prospects_active_status      ON prospects (active_status);
CREATE INDEX IF NOT EXISTS idx_prospects_postcode           ON prospects (postcode);
CREATE INDEX IF NOT EXISTS idx_prospects_postcode_source    ON prospects (postcode_source);
CREATE INDEX IF NOT EXISTS idx_prospects_first_discovered   ON prospects (first_discovered_at);
CREATE INDEX IF NOT EXISTS idx_prospects_first_scanned      ON prospects (first_scanned_at);

-- ── Seed: Cohort 001 existing records ─────────────────────────────────────────
--
-- Applies known values for the 35 firms already in the dataset.
-- postcode/town/county are intentionally left NULL — they were not collected
-- during Cohort 001 and should be populated by the enrich stage or manual review.

UPDATE prospects
SET
  cohort_id           = (SELECT id FROM cohorts WHERE cohort_code = '001'),
  regulator           = 'SRA',
  country             = 'Wales',
  active_status       = 'active',
  first_discovered_at = COALESCE(source_date::TIMESTAMPTZ, created_at),
  first_scanned_at    = last_scanned
WHERE
  cohort_id IS NULL
  AND sector = 'solicitors';

-- Postcodes already set on any existing record (unlikely, but idempotent):
-- if postcode is populated but provenance is missing, mark as manual.
UPDATE prospects
SET
  postcode_source     = 'manual',
  postcode_confidence = 100
WHERE
  postcode            IS NOT NULL
  AND postcode_source IS NULL;
