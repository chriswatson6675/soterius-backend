'use strict';

// Observation State store — OBS-101, WP-1. Thin persistence only: insert and
// single-row lookup against observation_states (migration 052). No
// due-selection query, no claim/lock semantics, no scheduling math — those
// belong to later work packages (WP-4/WP-5), not this one.
//
// Mirrors trust-intelligence/store.js's own conventions: an injectable
// `client` (defaulting to the real Supabase client) so callers/tests never
// need the real database, and snake_case<->camelCase translation at the
// boundary only.

function getClient() {
  return require('../../infra/database').getClient();
}

function toRow(record) {
  return {
    organisation_id: record.organisationId,
    observation_type: record.observationType,
    collection_group: record.collectionGroup,
    last_observed_at: record.lastObservedAt ?? null,
    next_due_at: record.nextDueAt ?? null,
    status: record.status,
    collector_version: record.collectorVersion ?? null,
    evidence_ref: record.evidenceRef ?? null,
    provenance_ref: record.provenanceRef ?? null,
    material_change: record.materialChange ?? null,
    attempt_count: record.attemptCount,
    last_failure_at: record.lastFailureAt ?? null,
    last_failure_reason: record.lastFailureReason ?? null,
  };
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    organisationId: row.organisation_id,
    observationType: row.observation_type,
    collectionGroup: row.collection_group,
    lastObservedAt: row.last_observed_at,
    nextDueAt: row.next_due_at,
    status: row.status,
    collectorVersion: row.collector_version,
    evidenceRef: row.evidence_ref,
    provenanceRef: row.provenance_ref,
    materialChange: row.material_change,
    attemptCount: row.attempt_count,
    lastFailureAt: row.last_failure_at,
    lastFailureReason: row.last_failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * insert(record, deps) — inserts one new Observation State row. Throws on a
 * duplicate (organisationId, observationType) pair (the migration's own
 * UNIQUE constraint) rather than silently upserting — callers that want
 * find-or-create semantics compose that themselves from insert()/
 * getByOrganisationAndType(), the same pattern already used elsewhere in this
 * codebase (e.g. findOrCreateProspect).
 */
async function insert(record, deps = {}) {
  const client = deps.client || getClient();
  const { data, error } = await client
    .from('observation_states')
    .insert(toRow(record))
    .select('*')
    .single();

  if (error) throw new Error(`observation_states insert failed: ${error.message}`);
  return fromRow(data);
}

/**
 * getByOrganisationAndType(organisationId, observationType, deps) →
 * the Observation State row for that pair, or null if none exists yet.
 */
async function getByOrganisationAndType(organisationId, observationType, deps = {}) {
  const client = deps.client || getClient();
  const { data, error } = await client
    .from('observation_states')
    .select('*')
    .eq('organisation_id', organisationId)
    .eq('observation_type', observationType)
    .maybeSingle();

  if (error) throw new Error(`observation_states read failed: ${error.message}`);
  return fromRow(data);
}

module.exports = { insert, getByOrganisationAndType };
