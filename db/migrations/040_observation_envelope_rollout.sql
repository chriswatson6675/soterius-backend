-- ── Migration 040: Observation Envelope rollout — 9 Observatory collectors ──
--
-- Sprint 9 of the ADR-SYS-009 implementation programme. Adds the canonical
-- Observation envelope (proven on DNSSEC, migration 039) to every remaining
-- Observatory-native collector's payload table, so all Observatory-native
-- collectors share one operational architecture.
--
-- Tables (9): signal_facts_spf, signal_facts_dmarc, signal_facts_dkim,
--   signal_facts_caa, signal_facts_mtasts, signal_securitytxt_v1, signal_tls_v1,
--   signal_certificate_v1, signal_securityheaders_v1.
--
-- Additive and idempotent (ADD COLUMN IF NOT EXISTS). ZERO data loss: existing
-- rows carry NULL envelope columns exactly as DNSSEC's did — the honest record
-- (they predate the ownership chain; P-5, Unknown ≠ Absent, applied to schema).
--
-- Envelope columns are IDENTICAL to migration 039's DNSSEC set. Notes:
--   * collector_version already exists on the *_v1 tables (TLS/Certificate/
--     Security Headers/security.txt) — ADD COLUMN IF NOT EXISTS skips it there and
--     adds it to the flat signal_facts_* tables that lack it.
--   * collection_run_id is DISTINCT from the *_v1 tables' pre-existing `run_id`
--     (a collector-local identifier). It is the FK to the canonical collection_runs.
--   * NOT added: any score, band, or judgement — interpretation stays in each
--     signal_quality_* table (P-2). Payload columns are untouched.
--
-- Apply via backend/tooling/db/apply-migration.js. The DO block keeps this DRY and
-- idempotent across all 9 tables; collection_runs / collection_programmes (mig 038)
-- must exist first (they do).

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'signal_facts_spf', 'signal_facts_dmarc', 'signal_facts_dkim',
    'signal_facts_caa', 'signal_facts_mtasts', 'signal_securitytxt_v1',
    'signal_tls_v1', 'signal_certificate_v1', 'signal_securityheaders_v1'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- ownership chain
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS collection_run_id UUID REFERENCES collection_runs(id) ON DELETE RESTRICT', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS collection_programme_id UUID REFERENCES collection_programmes(id) ON DELETE RESTRICT', t);
    -- collector identity & provenance
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS collector TEXT', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS collector_version TEXT', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS collection_method TEXT', t);
    -- subject / Repository Authority reference (nullable by contract)
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS organisation_id UUID', t);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS repository_authority_ref TEXT', t);
    -- envelope-level collection outcome (four-state)
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS collection_outcome TEXT', t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_collection_outcome_chk');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (collection_outcome IN (''OBSERVED_PRESENT'',''OBSERVED_ABSENT'',''NOT_OBSERVED'',''COLLECTION_ERROR'') OR collection_outcome IS NULL)',
      t, t || '_collection_outcome_chk'
    );
    -- the load-bearing access path: every Observation owned by one Collection Run
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (collection_run_id)', 'idx_' || t || '_collection_run', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (collection_outcome) WHERE collection_outcome IS NOT NULL', 'idx_' || t || '_collection_outcome', t);
  END LOOP;
END $$;
