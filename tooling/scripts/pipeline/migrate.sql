-- Research Pipeline V1 — Schema Migration
-- Run this in Supabase Dashboard → SQL Editor, or via migrate.js if DATABASE_URL is set.

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS pipeline_status        TEXT        DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS validation_status      TEXT,
  ADD COLUMN IF NOT EXISTS validation_checked_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rescan_due_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pipeline_flags         JSONB       DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pipeline_notes         TEXT;

CREATE INDEX IF NOT EXISTS idx_prospects_pipeline_status
  ON prospects (pipeline_status);

CREATE INDEX IF NOT EXISTS idx_prospects_rescan_due
  ON prospects (rescan_due_at)
  WHERE pipeline_status = 'scan_complete';

-- Seed pipeline_status for existing records
UPDATE prospects
  SET pipeline_status = 'scan_complete'
  WHERE last_scanned IS NOT NULL
    AND (pipeline_status = 'new' OR pipeline_status IS NULL);

UPDATE prospects
  SET pipeline_status = 'pending_validate'
  WHERE last_scanned IS NULL
    AND (pipeline_status = 'new' OR pipeline_status IS NULL);
