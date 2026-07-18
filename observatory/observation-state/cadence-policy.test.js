'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeNextDueAt, computeRetryNextDueAt, cadencePolicyFor,
  OBSERVATION_TYPE_CADENCE_POLICY, CADENCE_POLICIES, MAX_DAILY_RETRY_ATTEMPTS, SHARD_POLICY_VERSION,
} = require('./cadence-policy');
const shard = require('./shard-assignment');

const ORG = 'ORG-CADENCE-TEST-1';
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

describe('cadence policy assignment (active = v4 UTC 15m shards)', () => {
  test('SPF, DKIM, DMARC are daily-v4-utc-15m-shard', () => {
    assert.equal(cadencePolicyFor('spf'), 'daily-v4-utc-15m-shard');
    assert.equal(cadencePolicyFor('dkim'), 'daily-v4-utc-15m-shard');
    assert.equal(cadencePolicyFor('dmarc'), 'daily-v4-utc-15m-shard');
  });
  test('DNSSEC and CAA are weekly-v4-utc-7d-15m-shard', () => {
    assert.equal(cadencePolicyFor('dnssec'), 'weekly-v4-utc-7d-15m-shard');
    assert.equal(cadencePolicyFor('caa'), 'weekly-v4-utc-7d-15m-shard');
  });
  test('every DNS observation type has an assigned policy', () => {
    for (const t of ['spf', 'dkim', 'dmarc', 'dnssec', 'caa']) assert.ok(OBSERVATION_TYPE_CADENCE_POLICY[t]);
  });
  test('throws for an unassigned observation type', () => {
    assert.throws(() => cadencePolicyFor('mtasts'));
  });
  test('shard policy version is exported and stable', () => {
    assert.equal(SHARD_POLICY_VERSION, 'utc-shard-v1');
  });
  test('historical policy identifiers remain DEFINED and are not redefined (interpretation only)', () => {
    assert.equal(CADENCE_POLICIES['daily-v1'], DAY_MS);
    assert.equal(CADENCE_POLICIES['weekly-v1'], WEEK_MS);
    assert.equal(CADENCE_POLICIES['daily-v2-0930-london'], DAY_MS);
    assert.equal(CADENCE_POLICIES['weekly-v2-0930-london'], WEEK_MS);
    assert.equal(CADENCE_POLICIES['daily-v3-0830-utc'], DAY_MS);
    assert.equal(CADENCE_POLICIES['weekly-v3-fri-0830-utc'], WEEK_MS);
  });
  test('no live type maps to a superseded policy', () => {
    for (const p of Object.values(OBSERVATION_TYPE_CADENCE_POLICY)) {
      assert.ok(p === 'daily-v4-utc-15m-shard' || p === 'weekly-v4-utc-7d-15m-shard');
    }
  });
});

describe('computeNextDueAt — daily UTC shard', () => {
  test('lands exactly on the org\'s assigned 15-minute UTC slot', () => {
    const slot = shard.dailySlotIndex(ORG);
    const next = computeNextDueAt('2026-03-10T00:00:00.000Z', 'spf', ORG);
    const d = new Date(next);
    assert.equal(d.getUTCHours() * 4 + d.getUTCMinutes() / 15, slot);
    assert.equal(d.getUTCSeconds(), 0);
  });
  test('strictly after completion — before today\'s slot uses today; at/after uses tomorrow', () => {
    const slot = shard.dailySlotIndex(ORG);
    const slotMinOfDay = slot * 15;
    const before = new Date(Date.UTC(2026, 2, 10, 0, 0, 0)).toISOString();
    const nb = new Date(computeNextDueAt(before, 'spf', ORG));
    assert.equal(nb.getUTCDate(), 10); // today
    const at = new Date(Date.UTC(2026, 2, 10, Math.floor(slotMinOfDay / 60), slotMinOfDay % 60, 0)).toISOString();
    const na = new Date(computeNextDueAt(at, 'spf', ORG));
    assert.equal(na.getUTCDate(), 11); // tomorrow
  });
  test('requires organisationId for the active daily policy', () => {
    assert.throws(() => computeNextDueAt('2026-03-10T00:00:00.000Z', 'spf'));
  });
  test('DST-invariant: same UTC completion resolves onto the same slot in GMT and BST windows', () => {
    const gmt = new Date(computeNextDueAt('2026-01-10T00:00:00.000Z', 'dmarc', ORG));
    const bst = new Date(computeNextDueAt('2026-07-10T00:00:00.000Z', 'dmarc', ORG));
    assert.equal(gmt.getUTCHours(), bst.getUTCHours());
    assert.equal(gmt.getUTCMinutes(), bst.getUTCMinutes());
  });
  test('BST start/end dates (2026-03-29 / 2026-10-25) have no effect', () => {
    const slotMin = shard.dailySlotIndex(ORG) * 15;
    for (const day of ['2026-03-29', '2026-10-25']) {
      const n = new Date(computeNextDueAt(`${day}T00:00:00.000Z`, 'spf', ORG));
      assert.equal(n.getUTCHours() * 60 + n.getUTCMinutes(), slotMin);
    }
  });
  test('multi-day outage collapses to ONE future slot (no catch-up storm)', () => {
    const next = computeNextDueAt('2026-03-01T00:00:00.000Z', 'spf', ORG);
    const gap = Date.parse(next) - Date.parse('2026-03-01T00:00:00.000Z');
    assert.ok(gap <= DAY_MS);
  });
  test('no completion drift: repeated late runs keep the same slot minute-of-day', () => {
    const slotMin = shard.dailySlotIndex(ORG) * 15;
    for (const c of ['2026-04-01T13:07:00.000Z', '2026-04-02T22:59:00.000Z', '2026-04-09T03:00:00.000Z']) {
      const n = new Date(computeNextDueAt(c, 'spf', ORG));
      assert.equal(n.getUTCHours() * 60 + n.getUTCMinutes(), slotMin);
    }
  });
  test('month-end, year-end and leap-day completions still land on a 15-minute slot', () => {
    for (const c of ['2026-01-31T23:59:00.000Z', '2026-12-31T23:59:00.000Z', '2028-02-29T23:59:00.000Z']) {
      const n = new Date(computeNextDueAt(c, 'spf', ORG));
      assert.equal(n.getUTCSeconds(), 0);
      assert.equal((n.getUTCHours() * 60 + n.getUTCMinutes()) % 15, 0);
    }
  });
});

describe('computeNextDueAt — weekly seven-day UTC-cycle shard', () => {
  test('lands on the org\'s weekly slot inside the fixed epoch cycle', () => {
    const slot = shard.weeklySlotIndex(ORG);
    const next = Date.parse(computeNextDueAt('2026-03-10T00:00:00.000Z', 'dnssec', ORG));
    assert.equal(((next - shard.EPOCH_ANCHOR_MS) % WEEK_MS), slot * shard.SLOT_MS);
  });
  test('DNSSEC and CAA share the same weekly slot (kept together per org)', () => {
    const c = '2026-03-10T00:00:00.000Z';
    assert.equal(computeNextDueAt(c, 'dnssec', ORG), computeNextDueAt(c, 'caa', ORG));
  });
  test('NOT completion+7d — completions a day apart snap to the same weekly grid position', () => {
    const a = Date.parse(computeNextDueAt('2026-03-10T00:00:00.000Z', 'dnssec', ORG));
    const b = Date.parse(computeNextDueAt('2026-03-11T00:00:00.000Z', 'dnssec', ORG));
    assert.equal((a - shard.EPOCH_ANCHOR_MS) % WEEK_MS, (b - shard.EPOCH_ANCHOR_MS) % WEEK_MS);
  });
  test('multiple missed cycles collapse to ONE execution', () => {
    const next = computeNextDueAt('2026-01-01T00:00:00.000Z', 'caa', ORG);
    const gap = Date.parse(next) - Date.parse('2026-01-01T00:00:00.000Z');
    assert.ok(gap <= WEEK_MS);
  });
  test('year boundary and leap year still land on the weekly slot', () => {
    for (const c of ['2026-12-31T23:59:00.000Z', '2028-02-29T12:00:00.000Z']) {
      const next = Date.parse(computeNextDueAt(c, 'dnssec', ORG));
      assert.equal((next - shard.EPOCH_ANCHOR_MS) % WEEK_MS, shard.weeklySlotIndex(ORG) * shard.SLOT_MS);
    }
  });
  test('requires organisationId for the active weekly policy', () => {
    assert.throws(() => computeNextDueAt('2026-03-10T00:00:00.000Z', 'dnssec'));
  });
});

describe('computeNextDueAt — validation', () => {
  test('throws on an invalid observedAt', () => {
    assert.throws(() => computeNextDueAt('not-a-date', 'spf', ORG));
  });
  test('throws for an observation type with no assigned policy', () => {
    assert.throws(() => computeNextDueAt('2026-03-10T00:00:00.000Z', 'mtasts', ORG));
  });
});

describe('computeRetryNextDueAt — grid-aligned, non-drifting', () => {
  test('a normal retry is grid-aligned, deterministic, and within the per-org spread window', () => {
    const now = '2026-03-10T12:07:00.000Z';
    const next = computeRetryNextDueAt(now, 1, 'spf', ORG);
    const d = new Date(next);
    assert.equal(d.getUTCSeconds(), 0);
    assert.equal((d.getUTCHours() * 60 + d.getUTCMinutes()) % 15, 0); // on the quarter-hour grid
    const off = Date.parse(next) - Date.parse('2026-03-10T12:15:00.000Z');
    assert.ok(off >= 0 && off < shard.RETRY_SPREAD_BUCKETS * 15 * 60 * 1000, 'within the spread window');
    assert.equal(off, shard.retrySpreadOffsetSlots(ORG) * 15 * 60 * 1000, 'exactly the org offset');
    assert.equal(computeRetryNextDueAt(now, 1, 'spf', ORG), next, 'deterministic');
  });
  test('weekly retry stays grid-aligned and far under a week (not completion+7d)', () => {
    const next = computeRetryNextDueAt('2026-03-10T12:01:00.000Z', 2, 'dnssec', ORG);
    const delta = Date.parse(next) - Date.parse('2026-03-10T12:01:00.000Z');
    assert.ok(delta > 0 && delta < 3 * 60 * 60 * 1000);
  });
  test('mass simultaneous failure de-synchronises across the spread window', () => {
    const now = '2026-03-10T12:00:03.000Z';
    const times = new Set();
    for (let i = 0; i < 2000; i += 1) times.add(computeRetryNextDueAt(now, 1, 'spf', `ORG-MASS-${i}`));
    assert.ok(times.size >= shard.RETRY_SPREAD_BUCKETS - 1, `retries fan out across buckets, got ${times.size}`);
    for (const t of times) { const d = new Date(t); assert.equal((d.getUTCHours() * 60 + d.getUTCMinutes()) % 15, 0); }
  });
  test(`after MAX_DAILY_RETRY_ATTEMPTS (${MAX_DAILY_RETRY_ATTEMPTS}) a weekly signal falls back to its own weekly slot`, () => {
    const next = Date.parse(computeRetryNextDueAt('2026-03-10T12:01:00.000Z', MAX_DAILY_RETRY_ATTEMPTS + 1, 'dnssec', ORG));
    assert.equal((next - shard.EPOCH_ANCHOR_MS) % WEEK_MS, shard.weeklySlotIndex(ORG) * shard.SLOT_MS);
  });
  test('after exhaustion a daily signal falls back to its own daily slot', () => {
    const next = new Date(computeRetryNextDueAt('2026-03-10T12:01:00.000Z', MAX_DAILY_RETRY_ATTEMPTS + 1, 'spf', ORG));
    assert.equal(next.getUTCHours() * 60 + next.getUTCMinutes(), shard.dailySlotIndex(ORG) * 15);
  });
  test('a normal retry is always in the future and within a day', () => {
    const now = '2026-03-10T12:07:00.000Z';
    const delay = Date.parse(computeRetryNextDueAt(now, 1, 'spf', ORG)) - Date.parse(now);
    assert.ok(delay > 0 && delay <= DAY_MS);
  });
  test('throws on an invalid now', () => {
    assert.throws(() => computeRetryNextDueAt('not-a-date', 1, 'spf', ORG));
  });
  test('throws for an observation type with no assigned policy', () => {
    assert.throws(() => computeRetryNextDueAt('2026-03-10T12:00:00.000Z', 1, 'mtasts', ORG));
  });
});
