-- ── Migration 002: link submissions to scans ──────────────────────────────────
-- Adds a scan_id foreign key to the submissions table so that each gate
-- submission can be traced back to the exact scan record that preceded it.
-- Run after 001_create_scans_table.sql.

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS scan_id uuid REFERENCES scans(id) ON DELETE SET NULL;

-- Index for looking up "which submission used scan X"
CREATE INDEX IF NOT EXISTS idx_submissions_scan_id
  ON submissions (scan_id);
