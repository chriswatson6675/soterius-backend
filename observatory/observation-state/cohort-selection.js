'use strict';

// Cohort selection — OBS-102. Pure, deterministic selection logic for a
// bounded manual run, kept separate from the CLI's argv parsing so it can be
// tested directly.

class UnboundedRunRefusedError extends Error {
  constructor() {
    super('refusing to run: neither explicit organisation ids nor --limit was provided (no unbounded full-registry run)');
    this.name = 'UnboundedRunRefusedError';
  }
}

/**
 * selectCohort({ explicitIds, limit }, allOrganisationIds) → string[]
 *
 * - explicit organisation ids, if given, are used exactly as given (deduped,
 *   order preserved) — limit is ignored in this case.
 * - otherwise, with a positive --limit, deterministically selects the first
 *   N ids from allOrganisationIds sorted lexicographically (never random,
 *   never "however the source happened to return them").
 * - with neither explicit ids nor a limit, throws UnboundedRunRefusedError —
 *   there is no default that runs the full registry.
 */
function selectCohort({ explicitIds, limit } = {}, allOrganisationIds = []) {
  if (explicitIds && explicitIds.length) {
    return [...new Set(explicitIds)];
  }
  if (!limit || !Number.isInteger(limit) || limit <= 0) {
    throw new UnboundedRunRefusedError();
  }
  return [...allOrganisationIds].sort().slice(0, limit);
}

module.exports = { selectCohort, UnboundedRunRefusedError };
