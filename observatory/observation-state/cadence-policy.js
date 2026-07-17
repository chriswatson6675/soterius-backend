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
  // 09:30 Europe/London re-anchor (2026-07-17) — see next0930LondonAfter/
  // next0930LondonWeeklyAfter below for the actual due-date math; these
  // fixed-ms values are retained here only as the retry-backoff cap (the
  // longest a persistently-failing signal should ever wait before retrying),
  // not as the happy-path interval.
  'daily-v2-0930-london': 24 * 60 * 60 * 1000,
  'weekly-v2-0930-london': 7 * 24 * 60 * 60 * 1000,
};

const OBSERVATION_TYPE_CADENCE_POLICY = {
  spf: 'daily-v2-0930-london',
  dkim: 'daily-v2-0930-london',
  dmarc: 'daily-v2-0930-london',
  dnssec: 'weekly-v2-0930-london',
  caa: 'weekly-v2-0930-london',
};

const LONDON_TZ = 'Europe/London';
const ANCHOR_HOUR = 9;
const ANCHOR_MINUTE = 30;

/**
 * londonDateParts(ms) → { year, month, day, hour, minute } — the Europe/
 * London wall-clock reading for a UTC instant, via Intl's own tzdata (no
 * separate timezone dependency needed).
 */
function londonDateParts(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  const hour = get('hour');
  return { year: get('year'), month: get('month'), day: get('day'), hour: hour === 24 ? 0 : hour, minute: get('minute') };
}

/**
 * londonWallClockToUtcMs(year, month, day, hour, minute) → the UTC instant
 * for that Europe/London wall-clock reading. London's UTC offset is always
 * exactly 0 (GMT) or +60 minutes (BST), so one guess-and-correct pass —
 * guess the instant as if the wall-clock were already UTC, see what Intl
 * says that guess actually reads as in London, then shift by the difference
 * — is exact across the GMT/BST boundary without hand-rolling DST rules.
 */
function londonWallClockToUtcMs(year, month, day, hour, minute) {
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const shown = londonDateParts(guessUtcMs);
  const offsetMinutes = (shown.hour * 60 + shown.minute) - (hour * 60 + minute);
  return guessUtcMs - offsetMinutes * 60 * 1000;
}

/**
 * next0930LondonAfter(ms) → UTC ms of the next Europe/London 09:30 instant
 * strictly after `ms` — today's if `ms` is still before it, otherwise
 * tomorrow's.
 */
function next0930LondonAfter(ms) {
  const p = londonDateParts(ms);
  const todayCandidate = londonWallClockToUtcMs(p.year, p.month, p.day, ANCHOR_HOUR, ANCHOR_MINUTE);
  if (todayCandidate > ms) return todayCandidate;
  return londonWallClockToUtcMs(p.year, p.month, p.day + 1, ANCHOR_HOUR, ANCHOR_MINUTE);
}

/**
 * next0930LondonWeeklyAfter(ms) → UTC ms of 09:30 Europe/London exactly 7
 * calendar days after `ms`'s own London calendar date. Re-derives the GMT/
 * BST offset for the target date rather than adding a fixed 7×24h, so a
 * cadence that spans the clock-change weekend still lands on 09:30 local.
 */
function next0930LondonWeeklyAfter(ms) {
  const p = londonDateParts(ms);
  return londonWallClockToUtcMs(p.year, p.month, p.day + 7, ANCHOR_HOUR, ANCHOR_MINUTE);
}

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
  const observedAtMs = Date.parse(observedAtIso);
  if (Number.isNaN(observedAtMs)) {
    throw new Error(`computeNextDueAt: invalid observedAt "${observedAtIso}"`);
  }
  if (policy === 'daily-v2-0930-london') {
    return new Date(next0930LondonAfter(observedAtMs)).toISOString();
  }
  if (policy === 'weekly-v2-0930-london') {
    return new Date(next0930LondonWeeklyAfter(observedAtMs)).toISOString();
  }
  const durationMs = CADENCE_POLICIES[policy];
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
  next0930LondonAfter,
  next0930LondonWeeklyAfter,
  londonWallClockToUtcMs,
};
