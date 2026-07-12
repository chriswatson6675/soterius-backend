-- ── Migration 039: Canonical Observation Envelope — DNSSEC reference ────────
--
-- Sprint 6 of the ADR-SYS-009 implementation programme. Implements the Canonical
-- Observation Contract (Sprint 4) on ONE reference collector, DNSSEC, exactly as
-- the contract's own §6 recommended: additive, nullable envelope columns on the
-- existing signal_facts_dnssec table — NOT a new table, NOT a rewrite. This is
-- zero-data-loss: every historical DNSSEC observation keeps its columns untouched
-- and simply carries NULL envelope fields (they predate the ownership chain, which
-- is the honest record — P-5, Unknown ≠ Absent, applied to schema evolution).
--
-- ── One milestone, two files (038 + 039) ────────────────────────────────────
-- These envelope columns FK-reference collection_programmes / collection_runs
-- (migration 038). 039 therefore cannot apply before 038. Because 038 has not
-- been applied to any environment, there is no deployed intermediate schema to
-- preserve: {038, 039} are applied together as ONE coherent persistence milestone.
-- They are kept as two files only so each has a single reviewable responsibility
-- (ownership chain / observation envelope) — this is the opposite of "an
-- unnecessary intermediate schema version," since neither is ever deployed alone.
--
-- ── What is and is NOT added ─────────────────────────────────────────────────
-- Added: the signal-agnostic ENVELOPE (ownership, collector identity, collection
-- outcome, provenance, organisation reference). The signal-specific PAYLOAD (raw
-- ds_records/dnskey_records evidence + observed facts) ALREADY EXISTS on this
-- table (migration 011) and is untouched. Timing is already present too:
-- collected_at IS the contract's observed_at; created_at IS its persisted_at — so
-- no timing columns are duplicated.
--
-- NOT added: any score, band, label, or judgement. Interpretation lives in
-- signal_quality_dnssec (migration 030) and stays there (P-2). The DNSSEC Quality
-- Model reads only payload fields (dns_ds_present, dns_dnskey_present,
-- ds_digest_types, dnskey_algorithms, the two *_collection_error fields) and is
-- entirely unaffected by these additions.
--
-- Apply via backend/tooling/db/apply-migration.js. Idempotent
-- (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).

-- ── Ownership chain (nullable FKs; historical rows carry NULL) ───────────────
ALTER TABLE signal_facts_dnssec
  ADD COLUMN IF NOT EXISTS collection_run_id       UUID REFERENCES collection_runs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS collection_programme_id UUID REFERENCES collection_programmes(id) ON DELETE RESTRICT;

-- ── Collector identity & provenance ─────────────────────────────────────────
ALTER TABLE signal_facts_dnssec
  ADD COLUMN IF NOT EXISTS collector         TEXT,     -- 'dnssec'
  ADD COLUMN IF NOT EXISTS collector_version TEXT,     -- exact collector code version
  ADD COLUMN IF NOT EXISTS collection_method TEXT;     -- e.g. 'DoH:cloudflare-dns.com'

-- ── Subject / Repository Authority reference (nullable by contract — an
--    unresolved subject is NULL, never a guess; P-5, OC-6) ────────────────────
ALTER TABLE signal_facts_dnssec
  ADD COLUMN IF NOT EXISTS organisation_id          UUID,   -- no FK: Repository Authority is batch/ndjson today
  ADD COLUMN IF NOT EXISTS repository_authority_ref TEXT;    -- RA-belief snapshot marker at collection time

-- ── Envelope-level collection outcome (the Sprint-3 four-state, generalised) ──
-- Mechanically derived from the two three-state presence fields already on the
-- row; it is a collection-outcome fact, NOT an interpretation (no signed-ness
-- judgement — that is the Quality Model's ANCHORED/ISLAND/UNSIGNED, kept in
-- signal_quality_dnssec). NULL for historical rows written before this envelope.
ALTER TABLE signal_facts_dnssec
  ADD COLUMN IF NOT EXISTS collection_outcome TEXT;

ALTER TABLE signal_facts_dnssec
  DROP CONSTRAINT IF EXISTS sfdn_collection_outcome_values;
ALTER TABLE signal_facts_dnssec
  ADD CONSTRAINT sfdn_collection_outcome_values
    CHECK (
      collection_outcome IN ('OBSERVED_PRESENT','OBSERVED_ABSENT','NOT_OBSERVED','COLLECTION_ERROR')
      OR collection_outcome IS NULL
    );

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- The load-bearing new access path: "every Observation owned by one Collection Run".
CREATE INDEX IF NOT EXISTS idx_sfdn_collection_run
  ON signal_facts_dnssec (collection_run_id);

CREATE INDEX IF NOT EXISTS idx_sfdn_collection_programme
  ON signal_facts_dnssec (collection_programme_id);

CREATE INDEX IF NOT EXISTS idx_sfdn_collection_outcome
  ON signal_facts_dnssec (collection_outcome)
  WHERE collection_outcome IS NOT NULL;

-- organisation_id will be populated only once a live domain→Organisation resolver
-- exists (deferred by the contract); indexed now so that rollout is index-ready.
CREATE INDEX IF NOT EXISTS idx_sfdn_organisation
  ON signal_facts_dnssec (organisation_id)
  WHERE organisation_id IS NOT NULL;
