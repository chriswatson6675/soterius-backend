'use strict';

// Cadence Policy — OBS-102 / OBS-103.
//
// DETERMINISTIC FIXED-UTC 15-MINUTE SHARD RE-ANCHOR (OBS-103 full-coverage
// transition). The ACTIVE policies distribute each organisation deterministically
// across the UTC day (daily signals) and across a fixed seven-day UTC epoch
// cycle (weekly signals), computed with UTC calendar operations only — never
// Intl / Europe/London, so UK daylight-saving time has by construction no effect
// on any due calculation. See shard-assignment.js for the slot grid + math.
//
// Why the change (history, preserved):
//   * v1  (daily-v1/weekly-v1)          — plain fixed-offset from last-observed.
//   * v2  (*-0930-london)               — 09:30 Europe/London anchor; caused, in
//         GMT, a one-hour same-day miss against a fixed-UTC wake which, with
//         completion-anchored +7d rescheduling, permanently drifted the weekly
//         weekday and stretched the weekly period to 8 days.
//   * v3  (daily-v3-0830-utc /          — fixed 08:30 UTC daily, Friday 08:30 UTC
//         weekly-v3-fri-0830-utc)         weekly; removed DST + drift, but put the
//                                          whole population on one 08:30 boundary
//                                          (and a Friday weekly peak).
//   * v4  (ACTIVE, below)               — deterministic per-org 15-minute UTC
//                                          shards; smooth load, no DST, no drift,
//                                          weekly = one execution per deterministic
//                                          seven-day UTC cycle (NOT a named weekday).
//
// Versioned identifiers, never silently redefined: every historical id keeps its
// original meaning and remains computable for interpretation. Only
// OBSERVATION_TYPE_CADENCE_POLICY selects what is ACTIVE.

const shard = require('./shard-assignment');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const CADENCE_POLICIES = {
  // Historical, SUPERSEDED — retained only so persisted citations stay
  // interpretable. NOT assigned to any live observation type; do not reuse.
  'daily-v1': DAY_MS,
  'weekly-v1': WEEK_MS,
  'daily-v2-0930-london': DAY_MS,
  'weekly-v2-0930-london': WEEK_MS,
  'daily-v3-0830-utc': DAY_MS,
  'weekly-v3-fri-0830-utc': WEEK_MS,
  // ACTIVE — fixed-UTC 15-minute deterministic shards. The ms values are the
  // retry-backoff CAP only (longest a persistently-failing signal waits), never
  // the happy-path interval — the happy-path due time comes from the shard grid.
  'daily-v4-utc-15m-shard': DAY_MS,
  'weekly-v4-utc-7d-15m-shard': WEEK_MS,
};

const OBSERVATION_TYPE_CADENCE_POLICY = {
  spf: 'daily-v4-utc-15m-shard',
  dkim: 'daily-v4-utc-15m-shard',
  dmarc: 'daily-v4-utc-15m-shard',
  dnssec: 'weekly-v4-utc-7d-15m-shard',
  caa: 'weekly-v4-utc-7d-15m-shard',
};

function cadencePolicyFor(observationType) {
  const policy = OBSERVATION_TYPE_CADENCE_POLICY[observationType];
  if (!policy) throw new Error(`no cadence policy assigned for observation type "${observationType}"`);
  return policy;
}

/**
 * computeNextDueAt(observedAtIso, observationType, organisationId) → ISO-8601.
 *
 * The active v4 policies require organisationId (the shard is a function of
 * immutable identity). The next due time is the next occurrence of the org's
 * assigned deterministic UTC slot STRICTLY after the completion instant — a
 * point on an absolute grid, never completion+interval, so a late run returns to
 * its slot and a multi-period outage collapses to a single execution. Historical
 * fixed-offset policies remain computable (organisationId ignored) for
 * interpretation only.
 */
function computeNextDueAt(observedAtIso, observationType, organisationId) {
  const policy = cadencePolicyFor(observationType);
  const observedAtMs = Date.parse(observedAtIso);
  if (Number.isNaN(observedAtMs)) {
    throw new Error(`computeNextDueAt: invalid observedAt "${observedAtIso}"`);
  }
  if (policy === 'daily-v4-utc-15m-shard') {
    if (!organisationId) throw new Error('computeNextDueAt: organisationId is required for the active daily shard policy');
    return new Date(shard.nextDailySlotInstantAfter(organisationId, observedAtMs)).toISOString();
  }
  if (policy === 'weekly-v4-utc-7d-15m-shard') {
    if (!organisationId) throw new Error('computeNextDueAt: organisationId is required for the active weekly shard policy');
    return new Date(shard.nextWeeklySlotInstantAfter(organisationId, observedAtMs)).toISOString();
  }
  // Historical (superseded) fixed-offset policies — interpretation only.
  const durationMs = CADENCE_POLICIES[policy];
  return new Date(observedAtMs + durationMs).toISOString();
}

// Retry timing on failure. An every-15-minute Railway wake means the finest granularity at
// which any work can execute is the next quarter-hour boundary, so a TEMPORARY
// retry due-time is grid-aligned there (org-independent, fast — even for a
// weekly signal). After MAX_DAILY_RETRY_ATTEMPTS the state returns to its OWN
// normal deterministic slot so a chronically dead domain is not probed every
// wake forever. A subsequent SUCCESS always reschedules via computeNextDueAt back
// onto the org's normal slot, so failures/retries never permanently move the
// normal cadence and never land off-grid.
const MAX_DAILY_RETRY_ATTEMPTS = 5;

/**
 * computeRetryNextDueAt(nowIso, attemptCount, observationType, organisationId)
 *   → ISO-8601 string (a TEMPORARY retry due-time, distinct from the normal slot)
 */
function computeRetryNextDueAt(nowIso, attemptCount, observationType, organisationId) {
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) throw new Error(`computeRetryNextDueAt: invalid now "${nowIso}"`);
  const policy = cadencePolicyFor(observationType);
  const isActiveShard = policy === 'daily-v4-utc-15m-shard' || policy === 'weekly-v4-utc-7d-15m-shard';
  // Historical (superseded) policies: no shard/spread — next quarter-hour.
  if (!isActiveShard) return new Date(shard.nextQuarterHourAfter(nowMs)).toISOString();
  if (!organisationId) throw new Error('computeRetryNextDueAt: organisationId is required for the active shard policy');
  // Fast retries — deterministically SPREAD across quarter-hour wakes by org, so
  // a mass simultaneous failure fans out instead of synchronising onto one wake.
  if (attemptCount <= MAX_DAILY_RETRY_ATTEMPTS) {
    return new Date(shard.nextRetryInstantAfter(organisationId, nowMs)).toISOString();
  }
  // Exhausted fast retries → return to the signal's own normal slot.
  if (policy === 'weekly-v4-utc-7d-15m-shard') {
    return new Date(shard.nextWeeklySlotInstantAfter(organisationId, nowMs)).toISOString();
  }
  return new Date(shard.nextDailySlotInstantAfter(organisationId, nowMs)).toISOString();
}

module.exports = {
  CADENCE_POLICIES,
  OBSERVATION_TYPE_CADENCE_POLICY,
  MAX_DAILY_RETRY_ATTEMPTS,
  SHARD_POLICY_VERSION: shard.SHARD_POLICY_VERSION,
  cadencePolicyFor,
  computeNextDueAt,
  computeRetryNextDueAt,
};
