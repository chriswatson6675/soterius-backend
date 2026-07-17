-- ── Migration 050: Commercial Observatory — MVP-0 Foundation ────────────────
-- The minimum persistence for the Single-Organisation Profiler research
-- loop (Commercial Observatory execution architecture design, 2026-07-14):
-- Investigation -> Organisation Dossier (working memory) -> Claims/Evidence
-- -> Relationship Observations -> Discoveries -> Agent Events -> a
-- reviewable Commercial Authority Draft.
--
-- Deliberately NOT the constitutional Commercial Authority (COMM-001..006):
-- nothing here is a Canonical Partner record, and nothing in this schema
-- writes into, or is read by, the Organisation Authority or any canonical
-- Commercial Authority table. `commercial_authority_drafts` is an
-- Investigation-scoped, founder-reviewable artefact only — approving one
-- here has no effect on any canonical registry; that admission mechanism is
-- separate, future, COMM-003/004 engineering, not part of this migration.
--
-- Append-only discipline (mirrors migration 040/049's DB-trigger pattern):
-- commercial_claims, commercial_evidence, commercial_relationship_observations,
-- commercial_discoveries and commercial_agent_events are pure INSERT logs —
-- an UPDATE or DELETE is rejected at the database level. Superseding a claim
-- means inserting a new claim row with a new status, never editing the old
-- one. commercial_authority_drafts allows the review fields (review_state,
-- reviewed_by, reviewed_at, rejection_reason) to be updated by the founder
-- review action, but its `content` (the draft itself) is immutable once
-- written — enforced by a narrower trigger that only rejects a content
-- change, not every update. commercial_investigations and
-- commercial_dossiers are the two genuinely mutable tables: an
-- investigation's status/counters progress through controlled persistence
-- functions, and the dossier is explicit working memory, versioned but not
-- append-only (its whole point is to be overwritten as belief changes).
--
-- Apply via backend/tooling/db/migrate.js (Supabase MCP is read-only for
-- DDL). Idempotent.

-- ── commercial_investigations ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS commercial_investigations (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  target_name               TEXT,
  target_domain             TEXT,
  target_domain_normalised  TEXT,

  status                    TEXT        NOT NULL DEFAULT 'pending'
                                         CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled')),

  rerun_of                  UUID        REFERENCES commercial_investigations(id),

  step_count                INTEGER     NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  source_count              INTEGER     NOT NULL DEFAULT 0 CHECK (source_count >= 0),

  started_at                TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  failure_reason            TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT commercial_investigations_target_present
    CHECK (target_name IS NOT NULL OR target_domain IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_commercial_investigations_status
  ON commercial_investigations (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_commercial_investigations_domain
  ON commercial_investigations (target_domain_normalised);

CREATE INDEX IF NOT EXISTS idx_commercial_investigations_rerun_of
  ON commercial_investigations (rerun_of);

-- ── commercial_dossiers ───────────────────────────────────────────────────────
-- Mutable, versioned working memory — one row per investigation. This is
-- the Research Agent's Dossier (execution architecture design, §D); it is
-- deliberately NOT append-only, since revising belief as evidence
-- accumulates is its entire purpose. Prior states are not separately
-- retained here — the append-only commercial_agent_events log is the
-- audit trail of how the dossier arrived at its current state.
CREATE TABLE IF NOT EXISTS commercial_dossiers (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id  UUID        NOT NULL REFERENCES commercial_investigations(id),
  working_state     JSONB       NOT NULL,
  version           INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT commercial_dossiers_one_per_investigation UNIQUE (investigation_id)
);

-- ── commercial_claims ─────────────────────────────────────────────────────────
-- Append-only. A claim's value may be SQL NULL — that is how a claim
-- records "investigated, confirmed absent" (Unknown != Absent: the absence
-- of any row for a field is the true "unknown" state; a row with value
-- NULL is an investigated, honest not-found).
CREATE TABLE IF NOT EXISTS commercial_claims (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id  UUID        NOT NULL REFERENCES commercial_investigations(id),
  claim_type        TEXT        NOT NULL,
  field             TEXT        NOT NULL,
  value             JSONB,
  confidence        TEXT        NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  status            TEXT        NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'superseded', 'rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commercial_claims_investigation
  ON commercial_claims (investigation_id, field);

-- ── commercial_evidence ───────────────────────────────────────────────────────
-- Append-only. Referenced by id from commercial_claims / commercial_
-- relationship_observations (citation, not a DB foreign key on the citing
-- side's array columns — mirrors provenanceManifest's own reference-not-
-- join style elsewhere in this codebase).
CREATE TABLE IF NOT EXISTS commercial_evidence (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id       UUID        NOT NULL REFERENCES commercial_investigations(id),
  source_url             TEXT        NOT NULL,
  source_url_normalised  TEXT,
  retrieved_at           TIMESTAMPTZ NOT NULL,
  content_hash           TEXT,
  evidence_class         TEXT        NOT NULL CHECK (evidence_class IN ('public', 'published', 'third_party', 'manual')),
  context_excerpt        TEXT,
  source_title           TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commercial_evidence_investigation
  ON commercial_evidence (investigation_id);

-- ── commercial_relationship_observations ─────────────────────────────────────
-- Append-only. relationship_direction is always explicit (never derived
-- from relationship_type) — enforced at the application layer
-- (domain/relationship-observation.js); both columns are independently
-- NOT NULL here so a missing direction fails loudly rather than silently.
CREATE TABLE IF NOT EXISTS commercial_relationship_observations (
  id                             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id               UUID        NOT NULL REFERENCES commercial_investigations(id),
  subject_organisation           TEXT        NOT NULL,
  third_party_name               TEXT        NOT NULL,
  third_party_domain             TEXT,
  third_party_domain_normalised  TEXT,
  relationship_type              TEXT        NOT NULL CHECK (relationship_type IN (
                                    'regulator', 'professional_body', 'certification_body', 'trade_association',
                                    'client', 'client_sector', 'software_vendor', 'technology_partner',
                                    'referral_partner', 'strategic_partner', 'affiliated_organisation',
                                    'consultant', 'training_provider', 'conference_organiser', 'thought_leader',
                                    'supplier', 'competitor', 'unclassified'
                                  )),
  relationship_direction         TEXT        NOT NULL CHECK (relationship_direction IN ('outbound', 'inbound', 'mutual')),
  confidence                     TEXT        NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  relationship_confidence_state  TEXT        NOT NULL CHECK (relationship_confidence_state IN ('hypothesis', 'probable', 'verified')),
  context_excerpt                TEXT,
  evidence_references            UUID[]      NOT NULL DEFAULT '{}',
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commercial_relationship_observations_investigation
  ON commercial_relationship_observations (investigation_id);

CREATE INDEX IF NOT EXISTS idx_commercial_relationship_observations_type
  ON commercial_relationship_observations (relationship_type);

-- ── commercial_discoveries ────────────────────────────────────────────────────
-- Append-only. A Discovery is a candidate for a future, separately-decided
-- Investigation — it is never itself an admission into any canonical
-- registry, and this table has no foreign key toward one.
CREATE TABLE IF NOT EXISTS commercial_discoveries (
  id                                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id                     UUID        NOT NULL REFERENCES commercial_investigations(id),
  discovered_name                      TEXT        NOT NULL,
  discovered_domain                    TEXT,
  discovered_domain_normalised         TEXT,
  discovered_name_normalised           TEXT,
  discovery_reason                     TEXT        NOT NULL,
  proposed_relationship_type           TEXT        NOT NULL DEFAULT 'unclassified' CHECK (proposed_relationship_type IN (
                                          'regulator', 'professional_body', 'certification_body', 'trade_association',
                                          'client', 'client_sector', 'software_vendor', 'technology_partner',
                                          'referral_partner', 'strategic_partner', 'affiliated_organisation',
                                          'consultant', 'training_provider', 'conference_organiser', 'thought_leader',
                                          'supplier', 'competitor', 'unclassified'
                                        )),
  eligible_for_future_investigation    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commercial_discoveries_investigation
  ON commercial_discoveries (investigation_id);

CREATE INDEX IF NOT EXISTS idx_commercial_discoveries_domain
  ON commercial_discoveries (discovered_domain_normalised);

-- ── commercial_agent_events ───────────────────────────────────────────────────
-- Append-only. The complete audit trail a Research Session's activity is
-- reconstructed from (execution architecture design, §C resumability).
CREATE TABLE IF NOT EXISTS commercial_agent_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id  UUID        NOT NULL REFERENCES commercial_investigations(id),
  event_type        TEXT        NOT NULL CHECK (event_type IN (
                       'investigation_created', 'session_started', 'session_ended',
                       'observation_recorded', 'claim_recorded', 'evidence_stored',
                       'relationship_observed', 'discovery_emitted', 'question_generated',
                       'contradiction_recorded', 'tool_call_failed', 'draft_created', 'draft_reviewed'
                     )),
  step_number       INTEGER     NOT NULL CHECK (step_number >= 0),
  payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commercial_agent_events_investigation
  ON commercial_agent_events (investigation_id, step_number);

-- ── commercial_authority_drafts ───────────────────────────────────────────────
-- One draft per investigation. `content` is immutable once written; only
-- the review fields may subsequently change (via the founder review
-- action). This is NOT a Canonical Partner record — approving a draft here
-- has no write path into any canonical Commercial Authority or Organisation
-- Authority table.
CREATE TABLE IF NOT EXISTS commercial_authority_drafts (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id   UUID        NOT NULL REFERENCES commercial_investigations(id),
  content            JSONB       NOT NULL,
  review_state       TEXT        NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'approved', 'rejected')),
  reviewed_by        TEXT,
  reviewed_at        TIMESTAMPTZ,
  rejection_reason   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT commercial_authority_drafts_one_per_investigation UNIQUE (investigation_id)
);

-- ── Append-only enforcement (pure insert-log tables) ─────────────────────────
-- Mirrors migration 040/049's trigger pattern exactly: an UPDATE or DELETE
-- on any of these five tables is a defect, not an operational choice.
CREATE OR REPLACE FUNCTION commercial_observatory_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and immutable: % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  append_only_table TEXT;
BEGIN
  FOREACH append_only_table IN ARRAY ARRAY[
    'commercial_claims',
    'commercial_evidence',
    'commercial_relationship_observations',
    'commercial_discoveries',
    'commercial_agent_events'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_no_update ON %I', append_only_table, append_only_table);
    EXECUTE format(
      'CREATE TRIGGER %I_no_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION commercial_observatory_reject_mutation()',
      append_only_table, append_only_table
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I_no_delete ON %I', append_only_table, append_only_table);
    EXECUTE format(
      'CREATE TRIGGER %I_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION commercial_observatory_reject_mutation()',
      append_only_table, append_only_table
    );
  END LOOP;
END $$;

-- commercial_authority_drafts: narrower rule — content/investigation_id/
-- created_at are immutable; review_state/reviewed_by/reviewed_at/
-- rejection_reason may be updated by the review action. DELETE is always
-- rejected.
CREATE OR REPLACE FUNCTION commercial_authority_drafts_protect_content() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commercial_authority_drafts is append-only: DELETE is not permitted';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.investigation_id IS DISTINCT FROM OLD.investigation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'commercial_authority_drafts.content/investigation_id/created_at are immutable once written; only review_state, reviewed_by, reviewed_at and rejection_reason may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commercial_authority_drafts_no_delete ON commercial_authority_drafts;
CREATE TRIGGER commercial_authority_drafts_no_delete BEFORE DELETE ON commercial_authority_drafts
  FOR EACH ROW EXECUTE FUNCTION commercial_authority_drafts_protect_content();

DROP TRIGGER IF EXISTS commercial_authority_drafts_protect_content ON commercial_authority_drafts;
CREATE TRIGGER commercial_authority_drafts_protect_content BEFORE UPDATE ON commercial_authority_drafts
  FOR EACH ROW EXECUTE FUNCTION commercial_authority_drafts_protect_content();
