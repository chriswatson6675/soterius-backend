-- ── Migration 041: organisation_id UUID → TEXT (all Observation tables) ─────
--
-- Defect fix (Sprint 11). Migrations 039/040 declared the Observation envelope's
-- organisation_id as UUID, but Repository Authority's canonical identity scheme
-- (backend/authority/build.js primaryKeyOf) is `ORG-<sha1(pk).slice(0,12)>` — a
-- STRING, not a UUID. Resolving a real domain and persisting its ORG-<hash> id
-- therefore failed the UUID type check. Surfaced by the first live Organisation
-- resolution (all prior runs used domains that resolved NOT_FOUND → NULL → no
-- error). ADR-SYS-010 OC-6 fixes ORG-<hash> as the canonical id, so TEXT is the
-- correct column type.
--
-- SAFE: every organisation_id column is currently entirely NULL (no successful
-- linkage has ever been persisted), so nothing is lost.
--
-- IMPLEMENTATION NOTE: ALTER COLUMN ... TYPE rewrites the whole table (~2× disk),
-- which exhausted the Supabase volume. Because the column is entirely NULL, we
-- instead DROP + re-ADD it as TEXT — both are metadata-only catalogue operations
-- (no table rewrite, negligible disk). Dropping the column also drops its
-- dependent index, which we recreate. Idempotent (IF EXISTS / IF NOT EXISTS).
--
-- Apply via backend/tooling/db/apply-migration.js.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'signal_facts_dnssec', 'signal_facts_spf', 'signal_facts_dmarc',
    'signal_facts_dkim', 'signal_facts_caa', 'signal_facts_mtasts',
    'signal_securitytxt_v1', 'signal_tls_v1', 'signal_certificate_v1',
    'signal_securityheaders_v1'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- DROP the UUID column (drops its dependent index automatically) and re-ADD
    -- as TEXT. Metadata-only: no rewrite of the existing (large) tables.
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS organisation_id', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN organisation_id TEXT', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (organisation_id) WHERE organisation_id IS NOT NULL', 'idx_' || t || '_org', t);
  END LOOP;
END $$;
