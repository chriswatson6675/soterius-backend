'use strict';

// Observe Organisation — OBS-102 (DNS Observation Integration).
//
// For ONE organisation, runs the five DNS-based Observation types
// (spf/dkim/dmarc/dnssec/caa) via dns-signal-collection.js and creates or
// updates one Observation State per type, per the OBS-102 contract:
//
//   success -> last_observed_at = the Evidence's own collected_at (never
//     "now"), evidence_ref/provenance_ref set, collector_version recorded,
//     failure state reset, material_change computed conservatively,
//     next_due_at advanced per the assigned cadence policy.
//   failure -> Unknown != Absent preserved: attempt_count/last_failure_at/
//     last_failure_reason/status updated; the PREVIOUS successful
//     evidence_ref/provenance_ref/last_observed_at are never overwritten.
//
// Never generates or saves a Trust Profile (OBS-102 scope). Never calls
// Companies House, FCA, or SRA (out of scope — DNS-based signals only).

const { DNS_OBSERVATION_TYPES, collectDnsSignal } = require('./dns-signal-collection');
const { createObservationState } = require('./observation-state');
const { calculateMaterialChange } = require('./material-change');
const { computeNextDueAt } = require('./cadence-policy');
const store = require('./store');

function getClient() { return require('../../infra/database').getClient(); }

function defaultResolveDomain(organisationId, client) {
  const { reverse } = require('../../organisation/resolve');
  const result = reverse(organisationId);
  if (!result.ok) return { ok: false, error: result.error };
  const domain = result.row && result.row.verifiedDomain;
  if (!domain) return { ok: false, error: `organisation ${organisationId} has no verifiedDomain` };
  return { ok: true, domain };
}

/**
 * parseRef("signal_facts_spf:<uuid>") → { table: "signal_facts_spf", id: "<uuid>" }
 */
function parseRef(ref) {
  if (!ref) return null;
  const idx = ref.indexOf(':');
  if (idx === -1) return null;
  return { table: ref.slice(0, idx), id: ref.slice(idx + 1) };
}

async function fetchByRef(ref, client) {
  const parsed = parseRef(ref);
  if (!parsed) return null;
  const { data, error } = await client.from(parsed.table).select('*').eq('id', parsed.id).maybeSingle();
  if (error) return null;
  return data;
}

/**
 * observeOneSignal(organisationId, domain, signal, deps) →
 *   { signal, ok, observationState, error? }
 *
 * Handles the get-or-create + success/failure branching for exactly one
 * (organisationId, signal) pair. Exported separately from
 * observeOrganisationDnsSignals so tests can exercise one signal in
 * isolation (required: individual signal failure isolation).
 */
async function observeOneSignal(organisationId, domain, signal, deps = {}) {
  const client = deps.client || getClient();
  const collect = deps.collectDnsSignal || collectDnsSignal;
  const now = deps.now || (() => new Date().toISOString());
  const fetchEvidence = deps.fetchByRef || fetchByRef;

  let existing;
  try {
    existing = await store.getByOrganisationAndType(organisationId, signal, { client });
  } catch (err) {
    return { signal, ok: false, error: `Observation State read failed: ${err.message}` };
  }

  if (!existing) {
    const created = createObservationState({ organisationId, observationType: signal, collectionGroup: 'dns_batch' });
    existing = await store.insert(created, { client });
  }

  let result;
  try {
    result = await collect(domain, signal, deps.collectDeps || {});
  } catch (err) {
    result = { observed: false, scored: false, factsRow: null, qualityRow: null, error: err.message };
  }

  if (result.observed) {
    // Success — factsRow exists regardless of whether scoring itself
    // succeeded (Unknown != Absent: an observed-but-unscored signal is not a
    // failed Observation State).
    const previousEvidence = existing.evidenceRef ? await fetchEvidence(existing.evidenceRef, client) : null;
    const materialChange = calculateMaterialChange(previousEvidence, result.factsRow);

    const evidenceTable = deps.adapters
      ? deps.adapters[signal].tableName
      : require('../../collection/runs/national/run-national').nationalAdapters()[signal].tableName;
    const qualityTable = require('../quality/persist/on-demand-quality').ADAPTERS[signal].tableName;

    const lastObservedAt = result.factsRow.collected_at || now();
    const patch = {
      lastObservedAt,
      status: 'observed',
      collectorVersion: result.factsRow.collector_version || null,
      evidenceRef: `${evidenceTable}:${result.factsRow.id}`,
      provenanceRef: result.qualityRow ? `${qualityTable}:${result.qualityRow.id}` : existing.provenanceRef,
      materialChange: materialChange === null ? null : String(materialChange),
      attemptCount: 0,
      lastFailureAt: null,
      lastFailureReason: null,
      nextDueAt: computeNextDueAt(lastObservedAt, signal),
    };

    const updated = await store.update(organisationId, signal, patch, { client });
    // childError is surfaced here, not persisted to Observation State (no
    // schema change) — a caller/CLI should still be told when supplementary
    // evidence (e.g. DKIM key child rows) did not persist, even though the
    // primary Evidence and quality score are genuinely complete.
    return { signal, ok: true, observationState: updated, childError: result.childError || null };
  }

  // Failure — Unknown != Absent: never replace the last successful evidence
  // pointer or last_observed_at; only advance failure-tracking fields.
  const failurePatch = {
    status: 'failed',
    attemptCount: (existing.attemptCount || 0) + 1,
    lastFailureAt: now(),
    lastFailureReason: result.error || 'unknown collection failure',
  };
  const updated = await store.update(organisationId, signal, failurePatch, { client });
  return { signal, ok: false, observationState: updated, error: failurePatch.lastFailureReason };
}

/**
 * observeOrganisationDnsSignals(organisationId, deps) →
 *   { organisationId, domain, results: Array<{signal, ok, observationState, error?}> }
 *   | { organisationId, ok: false, error }  — when the organisation has no
 *     resolvable domain at all (no signal is attempted in that case).
 *
 * Runs all five DNS_OBSERVATION_TYPES for one organisation. One signal's
 * failure never aborts another's (mirrors the on-demand pipeline's own
 * per-signal isolation).
 */
async function observeOrganisationDnsSignals(organisationId, deps = {}) {
  const client = deps.client || getClient();
  const resolveDomain = deps.resolveDomain || defaultResolveDomain;

  const resolution = resolveDomain(organisationId, client);
  if (!resolution.ok) {
    return { organisationId, ok: false, error: resolution.error };
  }
  const { domain } = resolution;

  const results = [];
  for (const signal of DNS_OBSERVATION_TYPES) {
    try {
      results.push(await observeOneSignal(organisationId, domain, signal, deps));
    } catch (err) {
      results.push({ signal, ok: false, error: `unexpected error: ${err.message}` });
    }
  }

  return { organisationId, ok: true, domain, results };
}

module.exports = {
  observeOrganisationDnsSignals,
  observeOneSignal,
  parseRef,
  fetchByRef,
};
