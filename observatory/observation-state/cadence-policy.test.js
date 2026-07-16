'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeNextDueAt, cadencePolicyFor, OBSERVATION_TYPE_CADENCE_POLICY } = require('./cadence-policy');

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
