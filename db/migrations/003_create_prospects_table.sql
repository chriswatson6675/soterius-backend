-- ── Migration 003: create prospects table ─────────────────────────────────────
-- Stores professional services firms identified for market calibration and
-- benchmarking. A prospect may have many scans (linked via prospect_id in
-- the scans table — see migration 004).
-- Run before 004_add_prospect_id_to_scans.sql.

CREATE TABLE IF NOT EXISTS prospects (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  firm_name    text        NOT NULL,
  website      text        NOT NULL,              -- domain only, lowercased (e.g. smithllp.co.uk)
  sector       text,                              -- solicitors | accountants | financial-advisers | surveyors | other
  location     text,                             -- city / region (free text)
  source       text        NOT NULL DEFAULT 'manual', -- manual | sra-register | icaew-register | fca-register
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_scanned timestamptz,                       -- updated each time a scan is run via /api/prospects/:id/scan
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Unique on lowercased website so duplicate domains are rejected at DB level
CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_website
  ON prospects (lower(website));

-- Sector and location are the primary benchmark grouping dimensions
CREATE INDEX IF NOT EXISTS idx_prospects_sector
  ON prospects (sector);

CREATE INDEX IF NOT EXISTS idx_prospects_location
  ON prospects (location);

-- Ordered by last_scanned to surface unscanned prospects easily
CREATE INDEX IF NOT EXISTS idx_prospects_last_scanned
  ON prospects (last_scanned DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_prospects_source
  ON prospects (source);
