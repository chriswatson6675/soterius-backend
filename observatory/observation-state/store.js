'use strict';

// Observation State store — OBS-101 (insert/read), extended by OBS-102 with
// update() so a re-observation can advance an existing row rather than only
// ever inserting one. observation_states (migration 052) is the one
// deliberately mutable table in this model — update() is expected here, not
// a schema change. Still no due-selection query, no claim/lock semantics, no
// scheduling math — those belong to later work packages (WP-4/WP-5), not
// this one.
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

/**
 * update(organisationId, observationType, patch, deps) — updates the existing
 * Observation State row for that pair with the given partial field set
 * (camelCase keys, same shape as toRow() accepts). Throws if no row exists
 * yet for that pair — callers create one via insert() first (the same
 * get-or-create composition pattern getByOrganisationAndType()/insert()
 * already establish).
 */
async function update(organisationId, observationType, patch, deps = {}) {
  const client = deps.client || getClient();
  const partialRow = toPartialRow(patch);
  partialRow.updated_at = new Date().toISOString();

  const { data, error } = await client
    .from('observation_states')
    .update(partialRow)
    .eq('organisation_id', organisationId)
    .eq('observation_type', observationType)
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`observation_states update failed: ${error.message}`);
  if (!data) throw new Error(`observation_states update failed: no existing row for (${organisationId}, ${observationType})`);
  return fromRow(data);
}

const FIELD_MAP = {
  lastObservedAt: 'last_observed_at',
  nextDueAt: 'next_due_at',
  status: 'status',
  collectorVersion: 'collector_version',
  evidenceRef: 'evidence_ref',
  provenanceRef: 'provenance_ref',
  materialChange: 'material_change',
  attemptCount: 'attempt_count',
  lastFailureAt: 'last_failure_at',
  lastFailureReason: 'last_failure_reason',
};

/**
 * toPartialRow(patch) — translates only the camelCase keys actually present
 * in `patch` into their snake_case column names, so update() never overwrites
 * a field the caller didn't mention (unlike toRow(), which is only safe for
 * a full insert where every field has an explicit, intentional value).
 */
function toPartialRow(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    const column = FIELD_MAP[key];
    if (column) out[column] = value;
  }
  return out;
}

module.exports = { insert, getByOrganisationAndType, update };
