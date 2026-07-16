'use strict';

// Cadence Policy — OBS-102. Versioned policy identifiers (per the frozen
// Observation Domain Architecture's Cadence Policy concept), never scattered
// raw intervals — changing a cadence means introducing a new identifier, not
// silently redefining an old one out from under anything that already cites
// it.
//
// Initial values per OBS-102's own task assumptions (SPF/DKIM/DMARC/general
// DNS: daily; DNSSEC/CAA: weekly), pending any future ratified document that
// supersedes them.
//
// Deliberately NOT population-wide scheduling: computeNextDueAt is a plain
// fixed-interval calculation from one Organisation's own last-observed time.
// It does not apply the per-organisation deterministic spreading built for
// ENG-032 (scheduled-regeneration.js) — that spreading exists to prevent a
// whole population resynchronizing onto the same due date, which is a
// continuous-scheduler concern, explicitly out of scope for OBS-102's
// bounded, manual execution.

const CADENCE_POLICIES = {
  'daily-v1': 24 * 60 * 60 * 1000,
  'weekly-v1': 7 * 24 * 60 * 60 * 1000,
};

const OBSERVATION_TYPE_CADENCE_POLICY = {
  spf: 'daily-v1',
  dkim: 'daily-v1',
  dmarc: 'daily-v1',
  dnssec: 'weekly-v1',
  caa: 'weekly-v1',
};

function cadencePolicyFor(observationType) {
  const policy = OBSERVATION_TYPE_CADENCE_POLICY[observationType];
  if (!policy) throw new Error(`no cadence policy assigned for observation type "${observationType}"`);
  return policy;
}

/**
 * computeNextDueAt(observedAtIso, observationType) → ISO-8601 string
 */
function computeNextDueAt(observedAtIso, observationType) {
  const policy = cadencePolicyFor(observationType);
  const durationMs = CADENCE_POLICIES[policy];
  const observedAtMs = Date.parse(observedAtIso);
  if (Number.isNaN(observedAtMs)) {
    throw new Error(`computeNextDueAt: invalid observedAt "${observedAtIso}"`);
  }
  return new Date(observedAtMs + durationMs).toISOString();
}

// Retry timing on failure — deliberately deferred from OBS-102 to OBS-103
// (the scheduler work package) when this module was first written; this is
// that deferred work. Reuses the existing, generic backoffMs primitive
// (collection/sources/common/retry.js — verified source-agnostic, already
// shared by the FCA/SRA collectors) rather than inventing a second backoff
// formula. Capped at the observation type's own full cadence duration, so a
// persistently-failing signal never waits longer to retry than its normal
// cycle would have taken anyway.
const RETRY_BASE_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * computeRetryNextDueAt(nowIso, attemptCount, observationType) → ISO-8601 string
 */
function computeRetryNextDueAt(nowIso, attemptCount, observationType) {
  const { backoffMs } = require('../../collection/sources/common/retry');
  const cap = CADENCE_POLICIES[cadencePolicyFor(observationType)];
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) throw new Error(`computeRetryNextDueAt: invalid now "${nowIso}"`);
  const delay = Math.min(backoffMs(Math.max(attemptCount, 1), { baseDelayMs: RETRY_BASE_DELAY_MS, maxDelayMs: cap }), cap);
  return new Date(nowMs + delay).toISOString();
}

module.exports = {
  CADENCE_POLICIES,
  OBSERVATION_TYPE_CADENCE_POLICY,
  cadencePolicyFor,
  computeNextDueAt,
  computeRetryNextDueAt,
};
