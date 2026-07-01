-- Research Pipeline V4 — FCA Acquisition Support
-- Apply in Supabase Dashboard → SQL Editor.
-- Prerequisite: migrate_v3.sql must already be applied.
-- Idempotent: safe to run more than once.
--
-- Purpose:
--   Makes website nullable so firms can enter the dataset from authoritative registers
--   before a website is known. Records with no website enter with
--   pipeline_status = 'pending_enrichment' and await website discovery.

-- Make website nullable
ALTER TABLE prospects ALTER COLUMN website DROP NOT NULL;

-- Partial index for enrichment queue — fast lookup of no-website records
CREATE INDEX IF NOT EXISTS idx_prospects_pending_enrichment
  ON prospects (pipeline_status)
  WHERE pipeline_status = 'pending_enrichment';

-- Composite index for regulator identity lookups and deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_regulator_id
  ON prospects (regulator, regulator_id)
  WHERE regulator IS NOT NULL AND regulator_id IS NOT NULL;

-- Verify after applying:
-- SELECT is_nullable FROM information_schema.columns
--   WHERE table_name = 'prospects' AND column_name = 'website';
-- → should return 'YES'
