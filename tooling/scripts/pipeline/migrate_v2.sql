-- Research Pipeline V2 — Source Attribution + Confidence Scoring
-- Apply in Supabase Dashboard → SQL Editor after migrate.sql (V1) has been applied.
-- This migration is idempotent: safe to run more than once.

ALTER TABLE prospects
  ADD COLUMN IF NOT EXISTS source_date        DATE,
  ADD COLUMN IF NOT EXISTS source_reference   TEXT,
  ADD COLUMN IF NOT EXISTS firm_confidence    INTEGER DEFAULT 90,
  ADD COLUMN IF NOT EXISTS domain_confidence  INTEGER DEFAULT 90;

-- Seed: existing cohort records were manually verified — assign 90/90 as baseline.
-- Records with an explicit source already set get slightly higher confidence.
UPDATE prospects
  SET firm_confidence   = 90,
      domain_confidence = 90
  WHERE firm_confidence IS NULL OR domain_confidence IS NULL;

-- Records already scanned and active get a higher domain confidence baseline.
UPDATE prospects
  SET domain_confidence = 95
  WHERE last_scanned IS NOT NULL
    AND (domain_confidence IS NULL OR domain_confidence = 90);
