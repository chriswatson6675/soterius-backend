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

/**
 * getAllByOrganisation(organisationId, observationTypes, deps) →
 * every existing Observation State row for this organisation, restricted to
 * the given observation types. Used by OBS-103's claim logic to see what
 * already exists before attempting to claim it — a never-yet-observed type
 * has no row and needs no claim (insert-time uniqueness already protects it).
 */
async function getAllByOrganisation(organisationId, observationTypes, deps = {}) {
  const client = deps.client || getClient();
  const { data, error } = await client
    .from('observation_states')
    .select('*')
    .eq('organisation_id', organisationId)
    .in('observation_type', observationTypes);

  if (error) throw new Error(`observation_states read failed: ${error.message}`);
  return (data || []).map(fromRow);
}

/**
 * claim(organisationId, observationType, { nowIso, leaseMs }, deps) →
 * the row (now status: 'running') if the claim succeeded, or null if it
 * didn't — because another worker already holds a non-stale claim, or the
 * row is suspended.
 *
 * This is the SKIP LOCKED equivalent available through the Supabase REST
 * client (no raw SQL / `SELECT ... FOR UPDATE` access from here): a single
 * conditional UPDATE whose WHERE clause only matches a row that is not
 * suspended and is either not currently 'running' or has been 'running'
 * for longer than the lease (a crashed worker's stale claim). Only one
 * concurrent caller's UPDATE can ever match a given row — Postgres itself
 * serializes concurrent UPDATEs to the same row, and a second caller's WHERE
 * clause no longer matches once the first has flipped status to 'running'.
 */
async function claim(organisationId, observationType, { nowIso, leaseMs }, deps = {}) {
  const client = deps.client || getClient();
  const staleThreshold = new Date(Date.parse(nowIso) - leaseMs).toISOString();

  const { data, error } = await client
    .from('observation_states')
    .update({ status: 'running', updated_at: nowIso })
    .eq('organisation_id', organisationId)
    .eq('observation_type', observationType)
    .neq('status', 'suspended')
    .or(`status.neq.running,updated_at.lt.${staleThreshold}`)
    .select('*')
    .maybeSingle();

  if (error) throw new Error(`observation_states claim failed: ${error.message}`);
  return fromRow(data);
}

// Page size for the exhaustive provisioned-id scan. PostgREST caps a single
// response at the project's "Max Rows" (Supabase default 1000), so a plain
// unbounded .select() silently returns only the first page. We therefore page
// explicitly with .range() and cross-check total coverage against an exact
// count so a truncated read fails LOUDLY instead of silently omitting already-
// provisioned organisations (which would corrupt cohort exclusion at scale).
const PROVISIONED_PAGE_SIZE = 1000;

/**
 * listProvisionedOrganisationIds(deps) → the DISTINCT set of organisation ids
 * that already have at least one observation_states row, as a string[]. Used by
 * OBS-103 cohort provisioning to exclude already-provisioned organisations
 * (including the pilot) BEFORE deterministic rank selection.
 *
 * Truncation-proof: pages the full table via ordered .range() windows, measures
 * true coverage by the unique row `id` (not organisation_id, which repeats five
 * times per org), and asserts the number of rows actually retrieved equals the
 * server's exact `count`. Throws if a full page fails to advance (a server
 * ignoring range) or if coverage is short of the reported total. Read-only;
 * never mutates. `deps.pageSize` overridable for tests.
 */
async function listProvisionedOrganisationIds(deps = {}) {
  const client = deps.client || getClient();
  const pageSize = deps.pageSize || PROVISIONED_PAGE_SIZE;

  const organisationIds = new Set();
  const seenRowIds = new Set();
  let expectedCount = null;
  let from = 0;

  for (let page = 0; ; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error, count } = await client
      .from('observation_states')
      .select('id, organisation_id', { count: 'exact' })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`observation_states provisioned-ids read failed: ${error.message}`);
    if (expectedCount === null && typeof count === 'number') expectedCount = count;

    const rows = data || [];
    let newRowsThisPage = 0;
    for (const r of rows) {
      if (!seenRowIds.has(r.id)) { seenRowIds.add(r.id); newRowsThisPage += 1; }
      organisationIds.add(r.organisation_id);
    }

    if (rows.length < pageSize) break; // final (short) page → complete
    if (newRowsThisPage === 0) {
      throw new Error(`observation_states provisioned-ids retrieval stalled at offset ${from}: a full page advanced 0 new rows (server ignoring range?)`);
    }
    from += pageSize;
    // Runaway guard: never loop more than the reported table can justify.
    if (expectedCount !== null && page > Math.ceil(expectedCount / pageSize) + 2) {
      throw new Error(`observation_states provisioned-ids retrieval exceeded expected page count at offset ${from}`);
    }
  }

  if (expectedCount !== null && seenRowIds.size !== expectedCount) {
    throw new Error(`observation_states provisioned-ids retrieval incomplete: retrieved ${seenRowIds.size} of ${expectedCount} rows — refusing to return a truncated provisioned set`);
  }
  return Array.from(organisationIds);
}

module.exports = {
  insert, getByOrganisationAndType, update, getAllByOrganisation, claim, listProvisionedOrganisationIds,
  PROVISIONED_PAGE_SIZE,
};
