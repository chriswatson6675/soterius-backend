-- 004a — Create cohorts table (foundational, reconstructed for F3 reproducibility)
--
-- Why this migration exists:
--   `005_dataset_governance.sql` runs `ALTER TABLE cohorts ADD COLUMN ...` and
--   `CREATE INDEX ... ON cohorts (...)`, but no migration in this governed
--   sequence ever created `cohorts`. The only `CREATE TABLE cohorts` lived in
--   the non-canonical `tooling/scripts/pipeline/migrate_v3.sql`, which is NOT
--   part of the numbered migration series. A from-empty run therefore died at
--   005 ("relation \"cohorts\" does not exist").
--
--   This migration ports the canonical base structure of `cohorts` into the
--   governed sequence so the schema is self-contained and reproducible from an
--   empty database. It is ordered BEFORE 005 by `manifest.json` (and the `004a`
--   prefix also sorts between 004 and 005 lexically).
--
-- Schema-only: the North Wales Solicitors seed row that lived in migrate_v3.sql
-- is DML (research data), not schema, and is intentionally NOT reproduced here.
--
-- Idempotent: safe to run more than once.

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
