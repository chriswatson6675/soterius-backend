-- ── Migration 049: Compliance Evidence Events ───────────────────────────────
-- Compliance Advisor MVP — the minimum capability that lets an adviser
-- demonstrate a scheduled client review actually occurred (Compliance
-- Evidence architecture review, 2026-07-13).
--
-- Deliberately NOT the Observatory's constitutional `events` table
-- (migration 040, OBS-CONST-001 §3): that table's subject_type admission is
-- a governed constitutional act (OBS-CONST-001 §7), reserved for Reality/
-- Observation/Organisation-layer facts. A compliance review is an Experience
-- (ADR-SYS-010) — an adviser's own workflow action, not a claim about the
-- Organisation itself — so it belongs in its own table at the correct
-- layer, not admitted into the Observatory's governed subject registry.
-- This table mirrors that table's immutability *pattern* deliberately
-- (append-only, DB-trigger-enforced) without extending its governance.
--
-- Minimal by design (Compliance Evidence architecture review): no status,
-- no assignment, no due-date, no linkage to individual recommendations —
-- avoiding case management and a workflow engine. `type` exists solely so
-- this generalises later (e.g. a future `report_exported` value) without a
-- schema change — no value beyond 'review_completed' is used today.
--
-- Cadence/"due" status is deliberately NOT stored here — it is always
-- computed at read time from this log (see backend/compliance-evidence/
-- store.js#getLastReviewedAt), mirroring change-indicator.js's existing
-- "derive, never persist the derived value" pattern in this codebase.
--
-- Apply via backend/tooling/db/apply-migration.js (Supabase MCP is
-- read-only for DDL). Idempotent.

CREATE TABLE IF NOT EXISTS compliance_evidence_events (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id             TEXT        NOT NULL,
  customer_id                 UUID        NOT NULL,
  reviewed_by_user_id         UUID        NOT NULL,
  reviewed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- References the Trust Profile Instance current at review time
  -- (organisation_id, trust_profile_generated_at) — a citation, not a
  -- foreign key, mirroring provenanceManifest.organisationHistoryRefs'
  -- own reference-not-join style. Nullable only for the honest edge case
  -- of a review recorded before any Trust Profile Instance exists yet.
  trust_profile_generated_at  TIMESTAMPTZ,

  type                        TEXT        NOT NULL DEFAULT 'review_completed'
                                           CHECK (type IN ('review_completed')),
  note                        TEXT,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_evidence_events_org_reviewed
  ON compliance_evidence_events (organisation_id, reviewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_compliance_evidence_events_customer_reviewed
  ON compliance_evidence_events (customer_id, reviewed_at DESC);

-- ── Immutability enforced at the database ────────────────────────────────────
-- Append-only, mirroring migration 040's trigger pattern exactly: an UPDATE
-- or DELETE is a defect, not an operational choice, so it is rejected here,
-- not merely omitted from the application layer.
CREATE OR REPLACE FUNCTION compliance_evidence_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'compliance_evidence_events is append-only and immutable: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS compliance_evidence_events_no_update ON compliance_evidence_events;
CREATE TRIGGER compliance_evidence_events_no_update BEFORE UPDATE ON compliance_evidence_events
  FOR EACH ROW EXECUTE FUNCTION compliance_evidence_events_reject_mutation();

DROP TRIGGER IF EXISTS compliance_evidence_events_no_delete ON compliance_evidence_events;
CREATE TRIGGER compliance_evidence_events_no_delete BEFORE DELETE ON compliance_evidence_events
  FOR EACH ROW EXECUTE FUNCTION compliance_evidence_events_reject_mutation();
