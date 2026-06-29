-- ── Migration V5 — Dataset Governance (Migration A)
-- Implements all Critical Migration A items from the Dataset Governance Audit.
-- Apply in Supabase Dashboard → SQL Editor.
-- Idempotent: safe to run more than once.
--
-- A1 — Add subsector column to prospects
-- A3 — Create datasets table (formal dataset register)
-- A5 — Add dataset_id FK to prospects
-- A6a— Add regulator + subsector + dataset_id to cohorts table
--
-- After applying this SQL, run migrate_v5_data.js to backfill all DML:
--   node scripts/pipeline/migrate_v5_data.js

-- ── A1: Add subsector column ──────────────────────────────────────────────────

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS subsector TEXT;

CREATE INDEX IF NOT EXISTS idx_prospects_subsector
  ON prospects (subsector);

-- Composite index for sector + subsector benchmark queries
CREATE INDEX IF NOT EXISTS idx_prospects_sector_subsector
  ON prospects (sector, subsector);

-- ── A3: Create datasets table ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS datasets (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_code         TEXT          NOT NULL UNIQUE,
  name                 TEXT          NOT NULL,
  source_owner         TEXT          NOT NULL,
  sector               TEXT          NOT NULL,
  subsector            TEXT,
  regulator            TEXT,
  download_url         TEXT,
  identifier_type      TEXT,
  refresh_cadence      TEXT,
  legal_basis          TEXT,
  first_acquired_at    DATE,
  last_refreshed_at    DATE,
  entity_count         INTEGER,
  website_coverage_pct NUMERIC(5,2),
  status               TEXT          NOT NULL DEFAULT 'active',
  notes                TEXT,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_datasets_sector
  ON datasets (sector);

CREATE INDEX IF NOT EXISTS idx_datasets_regulator
  ON datasets (regulator);

CREATE INDEX IF NOT EXISTS idx_datasets_status
  ON datasets (status);

-- ── A5: Add dataset_id FK to prospects ────────────────────────────────────────

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS dataset_id UUID REFERENCES datasets(id);

CREATE INDEX IF NOT EXISTS idx_prospects_dataset_id
  ON prospects (dataset_id);

-- ── A6a: Extend cohorts table ─────────────────────────────────────────────────
-- Add regulator, subsector, dataset_id, and summary stats fields
-- so a cohort record can fully describe the acquisition it represents.

ALTER TABLE cohorts
  ADD COLUMN IF NOT EXISTS regulator            TEXT,
  ADD COLUMN IF NOT EXISTS subsector            TEXT,
  ADD COLUMN IF NOT EXISTS dataset_id           UUID   REFERENCES datasets(id),
  ADD COLUMN IF NOT EXISTS entity_count_actual  INTEGER,
  ADD COLUMN IF NOT EXISTS website_coverage_pct NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS mean_score           NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS scan_count           INTEGER;

CREATE INDEX IF NOT EXISTS idx_cohorts_regulator
  ON cohorts (regulator);

CREATE INDEX IF NOT EXISTS idx_cohorts_dataset_id
  ON cohorts (dataset_id);

-- ── Verification queries (run after applying) ─────────────────────────────────

-- Check prospects columns added:
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'prospects' AND column_name IN ('subsector', 'dataset_id');

-- Check datasets table created:
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'datasets';

-- Check cohorts extended:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'cohorts'
--   ORDER BY ordinal_position;
