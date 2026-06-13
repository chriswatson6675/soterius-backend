-- ── Migration 001: create scans table ────────────────────────────────────────
-- Every call to POST /api/scan creates one row here, permanently.
-- This is the authoritative source for scan history, trend analysis,
-- monitoring subscriptions, and future benchmarking.
-- Run once in Supabase SQL Editor (Settings → SQL Editor).

CREATE TABLE IF NOT EXISTS scans (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  domain          text        NOT NULL,
  scanned_at      timestamptz NOT NULL DEFAULT now(),
  scoring_version text        NOT NULL DEFAULT 'v1.0',
  overall_score   numeric,                    -- percentage 0–100 (queryable column)
  risk_band       text,                       -- Excellent / Good / Moderate Risk / High Risk / Critical Risk
  score_object    jsonb,                      -- full scoreObject: achievedPoints, totalMaximum, categoryBreakdown, ...
  scanner_results jsonb,                      -- full scanners array: per-category scores + individual check findings
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Domain lookup (used for trend queries: "all scans for example.co.uk")
CREATE INDEX IF NOT EXISTS idx_scans_domain
  ON scans (domain);

-- Domain + date (most common query: domain history ordered by time)
CREATE INDEX IF NOT EXISTS idx_scans_domain_scanned_at
  ON scans (domain, scanned_at DESC);

-- Global date index (used for dashboards, benchmarking windows)
CREATE INDEX IF NOT EXISTS idx_scans_scanned_at
  ON scans (scanned_at DESC);

-- GIN index on score_object for JSON path queries
-- (e.g. WHERE score_object->>'riskBand' = 'Critical Risk')
CREATE INDEX IF NOT EXISTS idx_scans_score_object
  ON scans USING gin (score_object);

-- GIN index on scanner_results for finding-level queries
-- (e.g. which domains have a FAIL on 'DMARC policy enforced')
CREATE INDEX IF NOT EXISTS idx_scans_scanner_results
  ON scans USING gin (scanner_results);
