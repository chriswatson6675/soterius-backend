'use strict';

// Full-population Observation State provisioning — OBS-103 (full-coverage
// transition). Idempotently creates the five DNS observation states
// (spf/dkim/dmarc/dnssec/caa) for every ELIGIBLE organisation — one with
// exactly one verified, uncontested, resolvable domain — deriving each state's
// initial next_due_at directly from the deterministic UTC shard policy so a
// newly provisioned organisation enters its assigned daily slot within 24h and
// its assigned weekly slot within the current seven-day cycle (never all
// immediately due at once).
//
// Idempotent and restartable by construction: it only inserts the (org, type)
// rows that do not yet exist, so it never duplicates or deletes, never disturbs
// the five pilot organisations' existing rows or evidence pointers, and a rerun
// simply resumes — every already-provisioned organisation is skipped. The
// (organisation_id, observation_type) UNIQUE constraint is the backstop against
// a concurrent double-insert.
//
// This module performs NO production writes on its own and NEVER in dry-run;
// the CLI gates real writes behind an explicit production flag + confirmation.

const { createObservationState } = require('./observation-state');
const { computeNextDueAt } = require('./cadence-policy');
const { DNS_OBSERVATION_TYPES } = require('./dns-signal-collection');

function getStore() { return require('./store'); }
function getResolve() { return require('../../organisation/resolve'); }

const DEFAULT_BATCH_SIZE = 500;

/**
 * enumerateEligibleOrganisations(deps) → [{ organisationId, domain }] for every
 * organisation whose single verified domain RESOLVES uncontested to it. Excludes
 * unverified, contested/ambiguous, and unresolved records. Deterministic order
 * (the authority enumeration order) so batching/resume are reproducible.
 */
function enumerateEligibleOrganisations(deps = {}) {
  const resolve = deps.resolve || getResolve();
  const ids = deps.organisationIds || resolve.listOrganisationIds();
  const eligible = [];
  for (const organisationId of ids) {
    const rev = resolve.reverse(organisationId);
    if (!rev.ok) continue;
    const domain = rev.row && rev.row.verifiedDomain;
    if (!domain) continue;
    const res = resolve.resolveOrganisationByDomain(domain);
    if (res.outcome === 'RESOLVED' && res.organisationId === organisationId) {
      eligible.push({ organisationId, domain });
    }
  }
  return eligible;
}

/**
 * buildInitialStateRecord(orgId, type, nowIso) → a never-yet-observed
 * Observation State record whose next_due_at is the org's next assigned
 * deterministic UTC slot strictly after nowIso.
 */
function buildInitialStateRecord(organisationId, observationType, nowIso) {
  const record = createObservationState({ organisationId, observationType, collectionGroup: 'dns_batch' });
  record.nextDueAt = computeNextDueAt(nowIso, observationType, organisationId);
  return record;
}

function emptySummary(eligibleCount, consideredCount, dryRun) {
  return {
    eligibleOrganisations: eligibleCount,
    consideredOrganisations: consideredCount,
    organisationsAlreadyComplete: 0,
    statesExisting: 0,
    statesToCreate: 0,
    statesCreated: 0,
    batches: 0,
    dryRun,
  };
}

/**
 * provisionObservationStates(opts, deps) → summary
 *
 * opts: { nowIso, batchSize, limit, dryRun }
 * deps: { store, eligible | resolve/organisationIds, client }
 *
 * dryRun (default true) computes the plan and writes NOTHING. Real writes only
 * occur when dryRun is explicitly false (the CLI additionally requires a
 * production flag + confirmation).
 */
async function provisionObservationStates({ nowIso = null, batchSize = DEFAULT_BATCH_SIZE, limit = null, dryRun = true } = {}, deps = {}) {
  const store = deps.store || getStore();
  const client = deps.client;
  const log = deps.log || (() => {});
  const now = nowIso || new Date().toISOString();

  const eligible = deps.eligible || enumerateEligibleOrganisations(deps);
  const considered = limit ? eligible.slice(0, limit) : eligible;
  const summary = emptySummary(eligible.length, considered.length, dryRun);

  for (let i = 0; i < considered.length; i += batchSize) {
    const batch = considered.slice(i, i + batchSize);
    summary.batches += 1;
    for (const { organisationId } of batch) {
      // eslint-disable-next-line no-await-in-loop
      const existing = await store.getAllByOrganisation(organisationId, DNS_OBSERVATION_TYPES, client ? { client } : {});
      const existingTypes = new Set(existing.map((e) => e.observationType));
      summary.statesExisting += existingTypes.size;
      const missing = DNS_OBSERVATION_TYPES.filter((t) => !existingTypes.has(t));
      if (missing.length === 0) { summary.organisationsAlreadyComplete += 1; continue; }
      for (const observationType of missing) {
        summary.statesToCreate += 1;
        if (dryRun) continue;
        const record = buildInitialStateRecord(organisationId, observationType, now);
        try {
          // eslint-disable-next-line no-await-in-loop
          await store.insert(record, client ? { client } : {});
          summary.statesCreated += 1;
        } catch (err) {
          // A concurrent provisioner or the pilot path may have created it
          // between our read and insert — the UNIQUE constraint makes that a
          // safe idempotent no-op, not a failure.
          if (!/duplicate|unique/i.test(err.message)) throw err;
        }
      }
    }
    log(`OBS-103 provision: batch ${summary.batches} — considered ${Math.min(i + batchSize, considered.length)}/${considered.length}, toCreate ${summary.statesToCreate}, created ${summary.statesCreated}`);
  }

  return summary;
}

module.exports = {
  enumerateEligibleOrganisations,
  buildInitialStateRecord,
  provisionObservationStates,
  DEFAULT_BATCH_SIZE,
};
