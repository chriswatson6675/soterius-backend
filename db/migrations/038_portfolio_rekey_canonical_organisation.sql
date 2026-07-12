-- 038_portfolio_rekey_canonical_organisation.sql
--
-- ADR-SYS-010 Platform Convergence — resolves the tracked debt recorded in
-- migration 025 (finding R-03): organisation_portfolio_items.organisation_id
-- was a provisional uuid FK -> prospects.id (the legacy organisation concept).
-- This repoints it at the canonical Organisation id space (ORG-<hash> strings,
-- Repository Authority / ADR-SYS-010).
--
-- SCHEMA ONLY here. The data backfill (resolving each prospect to its canonical
-- ORG-* id, and routing any ambiguous/no-confident-match to the Remediation
-- Ledger rather than deciding silently) runs in the companion script
-- backend/authority/portfolio-rekey/backfill.js — resolution is JS
-- (organisation/resolve.js reads the Repository Authority dataset) and cannot
-- be expressed in SQL. Run the backfill immediately after this migration.
--
-- Deliberately NOT a compatibility layer: prospects.id is abandoned as the
-- portfolio key, not translated on the fly. After this, organisation_id holds
-- canonical ORG-* ids only.

-- Drop the provisional FK to prospects (the legacy coupling).
ALTER TABLE organisation_portfolio_items
  DROP CONSTRAINT IF EXISTS organisation_portfolio_items_organisation_id_fkey;

-- Re-type the column from uuid to text to hold canonical ORG-* ids.
-- Existing values (legacy prospect uuids) become their text form transiently;
-- the backfill then overwrites every row with its canonical id or removes it
-- (recording the removal in the Remediation Ledger).
ALTER TABLE organisation_portfolio_items
  ALTER COLUMN organisation_id TYPE text USING organisation_id::text;

-- The unique/index definitions from migration 025 remain valid on text.

COMMENT ON COLUMN organisation_portfolio_items.organisation_id IS
  'Canonical Organisation id (ORG-<hash>, ADR-SYS-010). Re-keyed from prospects.id by migration 038 + backfill.js. No FK: the canonical Organisation has no single table (it is derived from Repository Authority); referential integrity is a resolution concern, not a DB constraint.';
