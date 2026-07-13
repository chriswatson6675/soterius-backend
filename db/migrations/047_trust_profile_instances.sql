-- ── Migration 047: Trust Profile Instances ──────────────────────────────────
-- ENG-014 WP-9 ("Implementation Considerations Resolution") — the storage/
-- current-resolution mechanism ENG-023 §3/§9/§12 and TI-CONST-001 TI-P-8
-- deliberately leave to implementation. This is an ordinary engineering
-- decision, not a constitutional one (ENG-014 WP-9's own completion
-- criterion #3: "No completion criterion here may reference a new
-- architectural decision").
--
-- Append-only: a row is INSERTed once and never UPDATEd or DELETEd
-- (TI-CONST-001 TI-P-4/TI-P-5 — a Trust Profile, once generated, is
-- immutable; history is never rewritten). "Current" resolves per ENG-023
-- §12's own default rule — the row with the latest generated_at for a given
-- organisation_id — via a plain query, not a maintained flag, so there is no
-- second, competing source of truth to keep in sync.
--
-- The full instance (all nine ENG-023 §6 fields) is stored as JSONB rather
-- than normalised into columns: this table's job is to make "current" and
-- "history" resolvable, not to make the instance queryable field-by-field —
-- that already happens in-process, in generate-trust-profile.js's output,
-- before this table is ever touched. Normalising would risk this table
-- silently drifting into a second definition of the ENG-023 contract.
--
-- Apply via backend/tooling/db/apply-migration.js (Supabase MCP is
-- read-only for DDL). Idempotent.

CREATE TABLE IF NOT EXISTS trust_profile_instances (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  TEXT        NOT NULL,
  generated_at     TIMESTAMPTZ NOT NULL,
  trigger          TEXT        NOT NULL CHECK (trigger IN ('scheduled', 'on-demand')),
  instance         JSONB       NOT NULL,   -- the full ENG-023 §6 nine-field object, verbatim
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- No two instances for the same organisation may share the same
  -- generated_at (ENG-023 I-3 / ENG-029 §10 — generation is a discrete,
  -- individually-timestamped act; a tie would break "exactly one current"
  -- resolving deterministically).
  CONSTRAINT trust_profile_instances_unique_generation UNIQUE (organisation_id, generated_at)
);

-- Serves ENG-023 §12's default current-resolution rule (latest generated_at
-- per organisation) and the historical-sequence read, both ORDER BY
-- generated_at DESC over one organisation_id.
CREATE INDEX IF NOT EXISTS idx_trust_profile_instances_org_generated
  ON trust_profile_instances (organisation_id, generated_at DESC);

-- No UPDATE/DELETE grant of any kind is defined here beyond ordinary table
-- ownership — append-only is enforced at the application layer
-- (backend/trust-intelligence/store.js never issues one), consistent with
-- how signal_quality_*/Observation tables already rely on the same
-- application-level discipline rather than a DB trigger.
