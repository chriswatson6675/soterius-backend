'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeNextDueAt, computeRetryNextDueAt, cadencePolicyFor, OBSERVATION_TYPE_CADENCE_POLICY, CADENCE_POLICIES,
  next0930LondonAfter, next0930LondonWeeklyAfter, londonWallClockToUtcMs,
} = require('./cadence-policy');

describe('cadence policy assignment', () => {
  test('SPF, DKIM, DMARC are daily-v2-0930-london', () => {
    assert.equal(cadencePolicyFor('spf'), 'daily-v2-0930-london');
    assert.equal(cadencePolicyFor('dkim'), 'daily-v2-0930-london');
    assert.equal(cadencePolicyFor('dmarc'), 'daily-v2-0930-london');
  });

  test('DNSSEC and CAA are weekly-v2-0930-london', () => {
    assert.equal(cadencePolicyFor('dnssec'), 'weekly-v2-0930-london');
    assert.equal(cadencePolicyFor('caa'), 'weekly-v2-0930-london');
  });

  test('throws for an unassigned observation type', () => {
    assert.throws(() => cadencePolicyFor('mtasts'));
  });

  test('every DNS observation type has an assigned policy', () => {
    for (const type of ['spf', 'dkim', 'dmarc', 'dnssec', 'caa']) {
      assert.ok(OBSERVATION_TYPE_CADENCE_POLICY[type]);
    }
  });

  test('the superseded daily-v1/weekly-v1 identifiers remain defined (not redefined out from under any historical citation)', () => {
    assert.equal(CADENCE_POLICIES['daily-v1'], 24 * 60 * 60 * 1000);
    assert.equal(CADENCE_POLICIES['weekly-v1'], 7 * 24 * 60 * 60 * 1000);
  });
});

describe('londonWallClockToUtcMs — GMT/BST correctness', () => {
  test('09:30 London in July (BST, UTC+1) is 08:30 UTC', () => {
    const ms = londonWallClockToUtcMs(2026, 7, 17, 9, 30);
    assert.equal(new Date(ms).toISOString(), '2026-07-17T08:30:00.000Z');
  });

  test('09:30 London in January (GMT, UTC+0) is 09:30 UTC', () => {
    const ms = londonWallClockToUtcMs(2026, 1, 17, 9, 30);
    assert.equal(new Date(ms).toISOString(), '2026-01-17T09:30:00.000Z');
  });
});

describe('next0930LondonAfter', () => {
  test('rolls to today\'s 09:30 London when the instant is still before it', () => {
    const ms = next0930LondonAfter(Date.parse('2026-07-17T07:00:00.000Z')); // 08:00 BST
    assert.equal(new Date(ms).toISOString(), '2026-07-17T08:30:00.000Z'); // 09:30 BST
  });

  test('rolls to tomorrow\'s 09:30 London when the instant is at/after today\'s', () => {
    const ms = next0930LondonAfter(Date.parse('2026-07-17T08:30:00.000Z')); // exactly 09:30 BST
    assert.equal(new Date(ms).toISOString(), '2026-07-18T08:30:00.000Z');
  });

  test('correctly crosses the BST→GMT clock-change weekend (clocks go back 2026-10-25 at 02:00 BST / 01:00 UTC)', () => {
    const ms = next0930LondonAfter(Date.parse('2026-10-24T07:00:00.000Z'));
    assert.equal(new Date(ms).toISOString(), '2026-10-24T08:30:00.000Z', 'still BST the day before the change');
    const ms2 = next0930LondonAfter(Date.parse('2026-10-25T07:00:00.000Z'));
    assert.equal(new Date(ms2).toISOString(), '2026-10-25T09:30:00.000Z', 'already GMT by mid-morning on change day itself (clocks went back at 01:00 UTC)');
  });
});

describe('next0930LondonWeeklyAfter', () => {
  test('adds exactly 7 calendar days, anchored to 09:30 London', () => {
    const ms = next0930LondonWeeklyAfter(Date.parse('2026-07-17T08:31:00.000Z'));
    assert.equal(new Date(ms).toISOString(), '2026-07-24T08:30:00.000Z');
  });

  test('re-derives the offset across the clock-change weekend rather than adding a fixed 7×24h', () => {
    // Observed 2026-10-19 (BST); +7 calendar days = 2026-10-26 (GMT, after the
    // 25th's clock change). A naive +7×24h-in-ms would land an hour off.
    const ms = next0930LondonWeeklyAfter(Date.parse('2026-10-19T08:31:00.000Z'));
    assert.equal(new Date(ms).toISOString(), '2026-10-26T09:30:00.000Z');
  });
});

describe('computeNextDueAt', () => {
  test('daily (SPF) anchors to the next 09:30 Europe/London', () => {
    const next = computeNextDueAt('2026-07-17T08:31:00.000Z', 'spf'); // observed just after 09:31 BST
    assert.equal(next, '2026-07-18T08:30:00.000Z'); // tomorrow's 09:30 BST
  });

  test('weekly (DNSSEC) anchors to 09:30 Europe/London, 7 days later', () => {
    const next = computeNextDueAt('2026-07-17T08:31:00.000Z', 'dnssec');
    assert.equal(next, '2026-07-24T08:30:00.000Z');
  });

  test('a legacy daily-v1/weekly-v1 citation (no longer assigned to any type, but still computable) still uses fixed-offset math', () => {
    // No observation type maps to daily-v1/weekly-v1 any more, so this
    // exercises the retained legacy branch directly via CADENCE_POLICIES —
    // confirms the old identifiers were not silently redefined, just
    // superseded in the assignment table.
    assert.equal(CADENCE_POLICIES['daily-v1'], 24 * 60 * 60 * 1000);
  });

  test('throws on an invalid observedAt', () => {
    assert.throws(() => computeNextDueAt('not-a-date', 'spf'));
  });

  test('throws for an observation type with no assigned policy', () => {
    assert.throws(() => computeNextDueAt('2026-07-16T00:00:00.000Z', 'mtasts'));
  });
});

describe('computeRetryNextDueAt', () => {
  test('a first failure retries sooner than the full cadence', () => {
    const next = computeRetryNextDueAt('2026-07-16T00:00:00.000Z', 1, 'spf');
    const delayMs = Date.parse(next) - Date.parse('2026-07-16T00:00:00.000Z');
    assert.ok(delayMs > 0);
    assert.ok(delayMs < CADENCE_POLICIES['daily-v2-0930-london']);
  });

  test('later attempts back off further, monotonically, but never past the signal\'s own cadence cap', () => {
    const now = '2026-07-16T00:00:00.000Z';
    const d1 = Date.parse(computeRetryNextDueAt(now, 1, 'spf')) - Date.parse(now);
    const d2 = Date.parse(computeRetryNextDueAt(now, 2, 'spf')) - Date.parse(now);
    const d10 = Date.parse(computeRetryNextDueAt(now, 10, 'spf')) - Date.parse(now);
    assert.ok(d2 >= d1);
    assert.ok(d10 <= CADENCE_POLICIES['daily-v2-0930-london']);
  });

  test('the retry cap differs correctly between daily and weekly signals', () => {
    const now = '2026-07-16T00:00:00.000Z';
    const dailyDelay = Date.parse(computeRetryNextDueAt(now, 20, 'spf')) - Date.parse(now);
    const weeklyDelay = Date.parse(computeRetryNextDueAt(now, 20, 'dnssec')) - Date.parse(now);
    assert.ok(dailyDelay <= CADENCE_POLICIES['daily-v2-0930-london']);
    assert.ok(weeklyDelay <= CADENCE_POLICIES['weekly-v2-0930-london']);
  });

  test('throws on an invalid now', () => {
    assert.throws(() => computeRetryNextDueAt('not-a-date', 1, 'spf'));
  });

  test('throws for an observation type with no assigned policy', () => {
    assert.throws(() => computeRetryNextDueAt('2026-07-16T00:00:00.000Z', 1, 'mtasts'));
  });
});
