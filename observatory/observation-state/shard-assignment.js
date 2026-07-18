'use strict';

// Deterministic UTC shard assignment — OBS-103 full-coverage scheduling.
//
// Distributes eligible organisations deterministically across the UTC day (and,
// for weekly signals, across a fixed seven-day UTC epoch cycle) so that no
// single 15-minute Railway wake carries the whole population. Assignment is a
// pure function of the immutable canonical organisation id — never of database
// row order, insertion order, mutable fields, randomness, or locale.
//
// Grid definition (all UTC, no timezone / no DST):
//   * 96 fifteen-minute daily slots  (96 × 15min = 24h exactly)
//   * 672 weekly slots               (672 × 15min = 168h = 7 days exactly),
//     positioned inside a fixed seven-day epoch cycle anchored at
//     EPOCH_ANCHOR_ISO (a Monday 00:00:00 UTC).
//
// Versioned: SHARD_POLICY_VERSION names this scheme. A future rebalance ships a
// NEW version (utc-shard-v2, new salts/bucket counts) — it never silently moves
// an already-assigned organisation, because existing next_due_at values are
// only recomputed at their own next natural reschedule.

const SHARD_POLICY_VERSION = 'utc-shard-v1';

const SLOT_MS = 15 * 60 * 1000;          // 15 minutes
const DAY_MS = 24 * 60 * 60 * 1000;      // 86,400,000
const WEEK_MS = 7 * DAY_MS;              // 604,800,000
const DAILY_SLOTS = 96;                  // DAY_MS / SLOT_MS
const WEEKLY_SLOTS = 672;                // WEEK_MS / SLOT_MS

// Immutable epoch anchor: 2024-01-01 is a Monday, 00:00:00 UTC. The weekly grid
// is EPOCH_ANCHOR + k·WEEK_MS + weeklySlot·SLOT_MS. Documented and frozen — do
// not change without a new SHARD_POLICY_VERSION.
const EPOCH_ANCHOR_ISO = '2024-01-01T00:00:00.000Z';
const EPOCH_ANCHOR_MS = Date.parse(EPOCH_ANCHOR_ISO);

const DAILY_SALT = ':daily:v1';
const WEEKLY_SALT = ':weekly:v1';
const RETRY_SALT = ':retry:v1';

// Retry spreading: a failed observation is not simply re-queued at the very next
// quarter-hour wake (which would synchronise an entire mass DNS/network outage
// onto one wake), but at a deterministic per-organisation offset of 0..N-1
// quarter-hour buckets after it. N buckets = N×15min of spread. 8 → up to 2h,
// which keeps a full-population outage's retries (~3,000 states) well under one
// wake's work budget while bounding retry latency.
const RETRY_SPREAD_BUCKETS = 8;

/**
 * fnv1a32(str) → unsigned 32-bit FNV-1a hash. Deterministic across Node
 * versions and platforms: pure integer arithmetic over UTF-16 code units
 * (Math.imul is exact 32-bit), no locale, no Math.random. Canonical org ids are
 * ASCII (ORG-<hex>) so there are no surrogate-pair concerns.
 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** dailySlotIndex(orgId) → integer in [0, 96). */
function dailySlotIndex(organisationId) {
  return fnv1a32(String(organisationId) + DAILY_SALT) % DAILY_SLOTS;
}

/** weeklySlotIndex(orgId) → integer in [0, 672). */
function weeklySlotIndex(organisationId) {
  return fnv1a32(String(organisationId) + WEEKLY_SALT) % WEEKLY_SLOTS;
}

function startOfUtcDay(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

/**
 * nextDailySlotInstantAfter(orgId, ms) → the org's assigned 15-minute daily slot
 * as the smallest instant STRICTLY after `ms`. Today's slot if `ms` is before
 * it, otherwise tomorrow's — so a multi-day outage collapses to exactly one
 * future occurrence (no per-missed-day catch-up), and the result is
 * DST-independent.
 */
function nextDailySlotInstantAfter(organisationId, ms) {
  const slot = dailySlotIndex(organisationId);
  let t = startOfUtcDay(ms) + slot * SLOT_MS;
  while (t <= ms) t += DAY_MS;
  return t;
}

/**
 * nextWeeklySlotInstantAfter(orgId, ms) → the org's assigned weekly slot inside
 * the fixed seven-day epoch cycle, as the smallest instant STRICTLY after `ms`.
 * Never completion+7d: always snaps back to EPOCH_ANCHOR + k·WEEK_MS +
 * slot·SLOT_MS, so a late or multi-cycle-missed run returns to the deterministic
 * weekly grid with no drift and no catch-up storm.
 */
function nextWeeklySlotInstantAfter(organisationId, ms) {
  const slot = weeklySlotIndex(organisationId);
  const base = EPOCH_ANCHOR_MS + slot * SLOT_MS; // first occurrence at/after the anchor
  const k = Math.ceil((ms - base) / WEEK_MS);
  let t = base + k * WEEK_MS;
  if (t <= ms) t += WEEK_MS;
  return t;
}

/**
 * nextQuarterHourAfter(ms) → the next :00/:15/:30/:45 UTC boundary strictly after
 * `ms` — the finest granularity the every-15-minute Railway wake can actually
 * execute. Used for temporary retry due-times (grid-aligned, org-independent).
 */
function nextQuarterHourAfter(ms) {
  const floored = Math.floor(ms / SLOT_MS) * SLOT_MS;
  return floored + SLOT_MS;
}

/** retrySpreadOffsetSlots(orgId) → integer in [0, RETRY_SPREAD_BUCKETS). */
function retrySpreadOffsetSlots(organisationId) {
  return fnv1a32(String(organisationId) + RETRY_SALT) % RETRY_SPREAD_BUCKETS;
}

/**
 * nextRetryInstantAfter(orgId, ms) → the org's deterministic retry instant: the
 * next quarter-hour boundary strictly after `ms`, plus a per-org offset of
 * 0..RETRY_SPREAD_BUCKETS-1 quarter-hours. Still perfectly grid-aligned, but a
 * mass simultaneous failure fans out across the spread window instead of
 * hammering one wake. Different orgs therefore also retry at different cadences,
 * so they never re-synchronise on subsequent failures.
 */
function nextRetryInstantAfter(organisationId, ms) {
  return nextQuarterHourAfter(ms) + retrySpreadOffsetSlots(organisationId) * SLOT_MS;
}

module.exports = {
  SHARD_POLICY_VERSION,
  EPOCH_ANCHOR_ISO,
  EPOCH_ANCHOR_MS,
  SLOT_MS,
  DAY_MS,
  WEEK_MS,
  DAILY_SLOTS,
  WEEKLY_SLOTS,
  RETRY_SPREAD_BUCKETS,
  fnv1a32,
  dailySlotIndex,
  weeklySlotIndex,
  retrySpreadOffsetSlots,
  nextDailySlotInstantAfter,
  nextWeeklySlotInstantAfter,
  nextQuarterHourAfter,
  nextRetryInstantAfter,
};
