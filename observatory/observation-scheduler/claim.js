'use strict';

// Organisation-level claiming — OBS-103.
//
// OBS-102's observeOrganisationDnsSignals() always runs all five DNS signals
// for one organisation together (see run-scheduler.js's own header for why
// this work package does not change that). To prevent two overlapping
// scheduler runs from both deciding the same organisation has a due signal
// and both invoking collection for it concurrently, claiming is organisation-
// scoped: every existing Observation State row for that organisation (across
// the five DNS types) must be claimed before collection starts.
//
// A never-yet-observed type has no row yet and needs no claim — the
// UNIQUE(organisation_id, observation_type) constraint from migration 052
// already prevents a genuine concurrent double-insert.
//
// If claiming succeeds for some but not all existing rows (lost a race
// partway through), the ones already claimed are deliberately NOT reverted —
// reverting risks clobbering a concurrent legitimate transition. They are
// left as 'running' and self-heal via the stale-claim lease mechanism
// (due-selection.js) on a future scheduler run. This organisation is skipped
// for the current run either way.

const { DNS_OBSERVATION_TYPES } = require('../observation-state/dns-signal-collection');
const store = require('../observation-state/store');
const { DEFAULT_LEASE_MS } = require('./due-selection');

function getClient() { return require('../../infra/database').getClient(); }

/**
 * claimOrganisationDnsStates(organisationId, deps) →
 *   { claimed: true, claimedTypes: string[] }
 *   | { claimed: false, reason: string, claimedTypes: string[] }
 */
async function claimOrganisationDnsStates(organisationId, deps = {}) {
  const client = deps.client || getClient();
  const now = deps.now || (() => new Date().toISOString());
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const nowIso = now();

  const existing = await store.getAllByOrganisation(organisationId, DNS_OBSERVATION_TYPES, { client });
  if (existing.length === 0) {
    // Nothing persisted yet for this organisation — no claim needed;
    // observeOrganisationDnsSignals will create fresh rows, and a genuine
    // concurrent race is caught by the insert's own UNIQUE constraint.
    return { claimed: true, claimedTypes: [] };
  }

  const claimedTypes = [];
  for (const row of existing) {
    // eslint-disable-next-line no-await-in-loop -- claims must be attempted
    // in sequence; each one's outcome decides whether to continue.
    const claimedRow = await store.claim(organisationId, row.observationType, { nowIso, leaseMs }, { client });
    if (!claimedRow) {
      return {
        claimed: false,
        reason: `could not claim "${row.observationType}" — already running elsewhere (not yet stale) or suspended`,
        claimedTypes,
      };
    }
    claimedTypes.push(claimedRow.observationType);
  }
  return { claimed: true, claimedTypes };
}

module.exports = { claimOrganisationDnsStates };
