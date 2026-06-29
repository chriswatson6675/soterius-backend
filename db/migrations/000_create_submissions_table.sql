-- ── Migration 000: create submissions table ───────────────────────────────────
-- The submissions table holds gate-form lead-capture records. Each row is one
-- gate submission; scan_id (added in 002) links it back to the scan that preceded it.
--
-- BACKFILL NOTE: This migration was reconstructed on 2026-06-29 from the original
-- Supabase SQL Editor snippets dated 2026-06-09 (the project's first schema work),
-- which had never been committed to the repo. The committed history previously began
-- at 001 (scans) and 002, which ALTERs submissions assuming it already exists — this
-- file restores the missing root of that chain so the migration set is self-contained.
-- It consolidates three original snippets, in their original order:
--   1. CREATE TABLE submissions               (2026-06-09 18:20)
--   2. submissions column expansion (12 cols) (2026-06-09 18:43)
--   3. DISABLE ROW LEVEL SECURITY             (2026-06-09 19:11)
--
-- Run before 001_create_scans_table.sql. Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS submissions (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email        VARCHAR(255) NOT NULL,
  domain       VARCHAR(255) NOT NULL,
  score        INTEGER      NOT NULL,
  risk_level   VARCHAR(20)  NOT NULL,
  created_at   TIMESTAMP    DEFAULT NOW(),
  scan_details JSONB,

  -- ── Column expansion (original snippet 2, 2026-06-09) ──────────────────────
  -- Per-category result bands captured at submission time.
  ssl            VARCHAR(50),
  headers        VARCHAR(50),
  email_sec      VARCHAR(50),
  vuln_comp      VARCHAR(50),
  gdpr           VARCHAR(50),
  -- Gate-form fields.
  name           VARCHAR(255),
  firm_name      VARCHAR(255),
  main_concern   TEXT,
  it_management  VARCHAR(50),
  data_incidents VARCHAR(50),
  confidence     INTEGER,
  scan_score     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_submissions_email  ON submissions (email);
CREATE INDEX IF NOT EXISTS idx_submissions_domain ON submissions (domain);

-- Row Level Security is disabled: this table is only ever accessed via the backend
-- using the service-role key, never directly from the browser/anon client.
ALTER TABLE submissions DISABLE ROW LEVEL SECURITY;
