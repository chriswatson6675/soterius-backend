'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeNextDueAt, computeRetryNextDueAt, cadencePolicyFor, OBSERVATION_TYPE_CADENCE_POLICY, CADENCE_POLICIES } = require('./cadence-policy');

describe('cadence policy assignment', () => {
  test('SPF, DKIM, DMARC are daily-v1', () => {
    assert.equal(cadencePolicyFor('spf'), 'daily-v1');
    assert.equal(cadencePolicyFor('dkim'), 'daily-v1');
    assert.equal(cadencePolicyFor('dmarc'), 'daily-v1');
  });

  test('DNSSEC and CAA are weekly-v1', () => {
    assert.equal(cadencePolicyFor('dnssec'), 'weekly-v1');
    assert.equal(cadencePolicyFor('caa'), 'weekly-v1');
  });

  test('throws for an unassigned observation type', () => {
    assert.throws(() => cadencePolicyFor('mtasts'));
  });

  test('every DNS observation type has an assigned policy', () => {
    for (const type of ['spf', 'dkim', 'dmarc', 'dnssec', 'caa']) {
      assert.ok(OBSERVATION_TYPE_CADENCE_POLICY[type]);
    }
  });
});

describe('computeNextDueAt', () => {
  test('daily-v1 adds exactly 24 hours', () => {
    const next = computeNextDueAt('2026-07-16T00:00:00.000Z', 'spf');
    assert.equal(next, '2026-07-17T00:00:00.000Z');
  });

  test('weekly-v1 adds exactly 7 days', () => {
    const next = computeNextDueAt('2026-07-16T00:00:00.000Z', 'dnssec');
    assert.equal(next, '2026-07-23T00:00:00.000Z');
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
    assert.ok(delayMs < CADENCE_POLICIES['daily-v1']);
  });

  test('later attempts back off further, monotonically, but never past the signal\'s own cadence cap', () => {
    const now = '2026-07-16T00:00:00.000Z';
    const d1 = Date.parse(computeRetryNextDueAt(now, 1, 'spf')) - Date.parse(now);
    const d2 = Date.parse(computeRetryNextDueAt(now, 2, 'spf')) - Date.parse(now);
    const d10 = Date.parse(computeRetryNextDueAt(now, 10, 'spf')) - Date.parse(now);
    assert.ok(d2 >= d1);
    assert.ok(d10 <= CADENCE_POLICIES['daily-v1']);
  });

  test('the retry cap differs correctly between daily and weekly signals', () => {
    const now = '2026-07-16T00:00:00.000Z';
    const dailyDelay = Date.parse(computeRetryNextDueAt(now, 20, 'spf')) - Date.parse(now);
    const weeklyDelay = Date.parse(computeRetryNextDueAt(now, 20, 'dnssec')) - Date.parse(now);
    assert.ok(dailyDelay <= CADENCE_POLICIES['daily-v1']);
    assert.ok(weeklyDelay <= CADENCE_POLICIES['weekly-v1']);
  });

  test('throws on an invalid now', () => {
    assert.throws(() => computeRetryNextDueAt('not-a-date', 1, 'spf'));
  });

  test('throws for an observation type with no assigned policy', () => {
    assert.throws(() => computeRetryNextDueAt('2026-07-16T00:00:00.000Z', 1, 'mtasts'));
  });
});
