'use strict';

// Claiming — OBS-103, corrected for independent cadence (2026-07-17).
//
// PREVIOUSLY: claiming was organisation-scoped and all-or-nothing — every
// EXISTING DNS row for an organisation was claimed together, whether or not
// it was actually due, specifically because observeOrganisationDnsSignals()
// always ran all five signals as one unit. That coupling is exactly what
// caused a daily-due SPF/DKIM/DMARC observation to sweep up and reset a
// not-yet-due weekly DNSSEC/CAA observation's cadence.
//
// NOW: OBS-102's observeOrganisationDnsSignals() accepts an explicit signal
// subset (deps.signalTypes), so claiming only needs to cover exactly the
// types the caller intends to collect — never "everything that happens to
// exist for this organisation." Organisation-level all-or-nothing exclusivity
// is no longer required for correctness: each (organisation_id,
// observation_type) row is claimed independently via store.claim()'s own
// atomic conditional UPDATE (the SKIP LOCKED equivalent), which already
// fully prevents two workers from claiming the SAME row — two workers
// claiming DIFFERENT types for the SAME organisation concurrently is safe,
// since observeOneSignal touches only its own row, with no cross-type shared
// state. A partial claim (some of the requested types lost a race) is not
// reverted and is not fatal — the caller proceeds with whatever it
// successfully claimed, which is itself always a fully safe, independently
// correct unit of work.

const { DEFAULT_LEASE_MS } = require('./due-selection');
const store = require('../observation-state/store');

function getClient() { return require('../../infra/database').getClient(); }

/**
 * claimDueObservationStates(organisationId, observationTypes, deps) →
 *   { claimed: boolean, claimedTypes: string[], skippedTypes: Array<{observationType, reason}> }
 *
 * `claimed` is true iff at least one type was successfully claimed — the
 * caller should collect exactly claimedTypes, not the originally-requested
 * list, since the two can differ under contention.
 */
async function claimDueObservationStates(organisationId, observationTypes, deps = {}) {
  const client = deps.client || getClient();
  const now = deps.now || (() => new Date().toISOString());
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const nowIso = now();

  if (!Array.isArray(observationTypes) || observationTypes.length === 0) {
    throw new Error('claimDueObservationStates: observationTypes must be a non-empty array');
  }

  const claimedTypes = [];
  const skippedTypes = [];
  for (const observationType of observationTypes) {
    // eslint-disable-next-line no-await-in-loop -- each claim's outcome is
    // independent; sequential is simplest and matches the small (<=5) size.
    const claimedRow = await store.claim(organisationId, observationType, { nowIso, leaseMs }, { client });
    if (claimedRow) {
      claimedTypes.push(claimedRow.observationType);
    } else {
      skippedTypes.push({ observationType, reason: 'already running elsewhere (not yet stale) or suspended' });
    }
  }

  return { claimed: claimedTypes.length > 0, claimedTypes, skippedTypes };
}

module.exports = { claimDueObservationStates };
