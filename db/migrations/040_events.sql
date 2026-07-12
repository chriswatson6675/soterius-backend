-- 040_events.sql
--
-- The Event — the permanently generic temporal envelope (OBS-CONST-001 §3:
-- "the immutable record that something constitutionally significant occurred").
-- Realised per the approved generic Event model: the Event owns NO domain
-- semantics; it references a constitutional subject and nothing more.
--
-- The envelope is FROZEN to exactly these columns. No further structured
-- columns may be added: if a future requirement seems to need a new Event
-- field, the data belongs on the referenced constitutional subject instead.
-- Only an amendment to OBS-CONST-001 may change this shape.
--
-- subject_type is validated by the governed subject registry
-- (observatory/events/subject-registry.js) — the single dispatch point — not by
-- a DB CHECK, so admitting a new constitutional subject is a governed
-- application-layer act, never a silent migration. subject_id is TEXT because
-- constitutional subjects have heterogeneous id types (observation UUIDs,
-- remediation-ledger ids, Repository Authority version strings).

CREATE TABLE IF NOT EXISTS events (
  event_id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Reference to a constitutional subject (the only thing an Event carries).
  subject_type                  TEXT        NOT NULL,
  subject_id                    TEXT        NOT NULL,

  -- Every Event is about an Organisation (P-1), but one referencing an
  -- as-yet-unresolved observation has no org yet — hence nullable.
  organisation_id               TEXT,

  -- Bitemporal pair (P-4): when it happened / became true, and when the
  -- Observatory recorded it. Both required — this is what makes "what did we
  -- believe as-of D" and "what do we now understand was true as-of D" both
  -- answerable later, without editing the past.
  occurred_at                   TIMESTAMPTZ NOT NULL,
  recorded_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Temporal-projection coordinates (nullable): the version context needed to
  -- reproduce identity as-of D (RA version) and trust as-of D (QM version).
  -- These are reproduction context, not subject payload — the only version
  -- stamps the envelope carries.
  repository_authority_version  TEXT,
  quality_model_version         TEXT,

  -- Free-form. The escape valve — but structured, type-specific data belongs on
  -- the referenced subject, never accreted here.
  metadata                      JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS events_organisation_id_idx ON events (organisation_id, occurred_at);
CREATE INDEX IF NOT EXISTS events_occurred_at_idx     ON events (occurred_at);
CREATE INDEX IF NOT EXISTS events_subject_idx         ON events (subject_type, subject_id);

-- ── Immutability enforced at the database (P-3, P-4) ─────────────────────────
-- The Event log is append-only and never edited. An UPDATE or DELETE is a
-- constitutional violation, not an operational choice, so it is blocked here —
-- not merely by the application omitting update/delete functions.
CREATE OR REPLACE FUNCTION events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only and immutable (OBS-CONST-001 P-3/P-4): % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_no_update ON events;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION events_reject_mutation();

DROP TRIGGER IF EXISTS events_no_delete ON events;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_reject_mutation();
