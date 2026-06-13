-- ── Migration 004: add prospect_id FK to scans table ─────────────────────────
-- Links scan records to the prospects table so every automated prospect scan
-- can be retrieved via /api/prospects/:id and included in benchmark aggregations.
-- Run after 003_create_prospects_table.sql.

ALTER TABLE scans
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES prospects(id) ON DELETE SET NULL;

-- Allows fast retrieval of all scans for a given prospect
CREATE INDEX IF NOT EXISTS idx_scans_prospect_id
  ON scans (prospect_id);
