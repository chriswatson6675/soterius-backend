-- ── Migration 044: Storage capacity telemetry ───────────────────────────────
--
-- Production-hardening sprint, Blocker 1 (Storage Capacity). Provides the two
-- persistence-layer primitives the storage monitor needs:
--
--   1. observatory_table_sizes()   — a read-only function returning per-table
--      total byte size + live row estimate, callable from the service-role client
--      via PostgREST rpc. (PostgREST cannot run pg_total_relation_size() directly,
--      hence a SECURITY DEFINER function.)
--
--   2. storage_capacity_snapshots  — an append-only telemetry table holding one
--      row per capacity snapshot (totals, per-table stats, growth, forecast,
--      warnings).
--
-- EVIDENCE INTEGRITY: this migration adds NOTHING that deletes or expires
-- constitutional evidence. Observations and Events are untouched and remain
-- immutable/append-only. The snapshot table is a TEMPORARY OPERATIONAL ARTEFACT
-- (telemetry, not evidence) and MAY therefore carry a retention policy — a
-- convenience pruning helper is provided below and is the ONLY deletion path in
-- this migration; it can only ever remove old telemetry snapshots, never evidence.
--
-- Apply via backend/tooling/db/apply-migration.js --confirm. Idempotent.

-- 1 ── Per-table size + row estimate. STABLE + SECURITY DEFINER so the anon/
--      service client can read catalog sizes without direct catalog grants.
CREATE OR REPLACE FUNCTION observatory_table_sizes()
RETURNS TABLE (table_name TEXT, total_bytes BIGINT, row_estimate BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT
    c.relname::TEXT                              AS table_name,
    pg_total_relation_size(c.oid)::BIGINT        AS total_bytes,
    GREATEST(c.reltuples, 0)::BIGINT             AS row_estimate
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
  ORDER BY pg_total_relation_size(c.oid) DESC;
$$;

-- 2 ── Append-only capacity snapshots (operational telemetry).
CREATE TABLE IF NOT EXISTS storage_capacity_snapshots (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  total_rows   BIGINT,
  total_bytes  BIGINT,

  -- Per-table stats [{table, group, rows, bytes}], group aggregates, growth vs
  -- previous, forecast, and the warnings raised — the full report, for trend
  -- charts and audits.
  tables       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  groups       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  growth       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  forecast     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  warnings     JSONB       NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_storage_capacity_snapshots_captured_at
  ON storage_capacity_snapshots (captured_at DESC);

-- 3 ── Retention helper for the TELEMETRY table ONLY. This is explicitly NOT an
--      evidence-retention policy: it prunes old capacity snapshots (operational
--      artefacts), and is physically incapable of touching Observations or
--      Events. Retention window is the caller's choice (default 365 days).
CREATE OR REPLACE FUNCTION prune_storage_capacity_snapshots(retain_days INTEGER DEFAULT 365)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM storage_capacity_snapshots
  WHERE captured_at < NOW() - (retain_days || ' days')::interval;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
