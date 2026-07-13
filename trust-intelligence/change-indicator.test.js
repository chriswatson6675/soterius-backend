'use strict';

// change-indicator.test.js — ENG-014 Portfolio Management. Covers the three
// branches of computeChangeIndicator() against minimal fake instances shaped
// like the real ENG-023 §6/§9 contract (trustScore.value/band), following
// the same `instance()` helper convention as trust-profile.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeChangeIndicator } = require('./change-indicator');

function entry(generatedAt, value, overrides = {}) {
  return {
    generatedAt,
    instance: {
      organisationId: 'ORG-1',
      trustScore: { value, band: typeof value === 'number' ? 'Good' : undefined },
      ...overrides,
    },
  };
}

describe('computeChangeIndicator', () => {
  test('0 instances → { status: "no-data" }', () => {
    assert.deepStrictEqual(computeChangeIndicator([]), { status: 'no-data' });
  });

  test('0 instances (undefined/null history) → { status: "no-data" }', () => {
    assert.deepStrictEqual(computeChangeIndicator(undefined), { status: 'no-data' });
    assert.deepStrictEqual(computeChangeIndicator(null), { status: 'no-data' });
  });

  test('1 instance → status "new", current set, previous/delta/direction null', () => {
    const history = [entry('2026-07-01T00:00:00.000Z', 750)];
    assert.deepStrictEqual(computeChangeIndicator(history), {
      status: 'new', current: 750, previous: null, delta: null, direction: null,
    });
  });

  test('2 instances, score increased → status "ok", direction "up"', () => {
    const history = [
      entry('2026-06-01T00:00:00.000Z', 700),
      entry('2026-07-01T00:00:00.000Z', 750),
    ];
    assert.deepStrictEqual(computeChangeIndicator(history), {
      status: 'ok', current: 750, previous: 700, delta: 50, direction: 'up',
    });
  });

  test('2 instances, score decreased → direction "down"', () => {
    const history = [
      entry('2026-06-01T00:00:00.000Z', 750),
      entry('2026-07-01T00:00:00.000Z', 700),
    ];
    const result = computeChangeIndicator(history);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.delta, -50);
    assert.strictEqual(result.direction, 'down');
  });

  test('2 instances, unchanged score → direction "flat", delta 0', () => {
    const history = [
      entry('2026-06-01T00:00:00.000Z', 700),
      entry('2026-07-01T00:00:00.000Z', 700),
    ];
    const result = computeChangeIndicator(history);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.delta, 0);
    assert.strictEqual(result.direction, 'flat');
  });

  test('picks the two most recent by generatedAt, not array order (sorts defensively)', () => {
    // Deliberately out of chronological order and with a 3rd, older entry.
    const history = [
      entry('2026-07-01T00:00:00.000Z', 750),
      entry('2026-05-01T00:00:00.000Z', 600),
      entry('2026-06-01T00:00:00.000Z', 700),
    ];
    const result = computeChangeIndicator(history);
    assert.strictEqual(result.current, 750);
    assert.strictEqual(result.previous, 700);
    assert.strictEqual(result.delta, 50);
  });

  test('rounds a non-integer delta to 2dp to avoid floating-point noise', () => {
    const history = [
      entry('2026-06-01T00:00:00.000Z', 10.1),
      entry('2026-07-01T00:00:00.000Z', 10.4),
    ];
    const result = computeChangeIndicator(history);
    assert.strictEqual(result.delta, 0.3);
  });

  test('non-numeric current trustScore.value (INSUFFICIENT_OBSERVATION) → delta/direction stay null, values pass through verbatim', () => {
    const history = [
      entry('2026-06-01T00:00:00.000Z', 700),
      entry('2026-07-01T00:00:00.000Z', 'INSUFFICIENT_OBSERVATION'),
    ];
    assert.deepStrictEqual(computeChangeIndicator(history), {
      status: 'ok', current: 'INSUFFICIENT_OBSERVATION', previous: 700, delta: null, direction: null,
    });
  });

  test('non-numeric previous trustScore.value → delta/direction stay null', () => {
    const history = [
      entry('2026-06-01T00:00:00.000Z', 'INSUFFICIENT_OBSERVATION'),
      entry('2026-07-01T00:00:00.000Z', 750),
    ];
    const result = computeChangeIndicator(history);
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.current, 750);
    assert.strictEqual(result.previous, 'INSUFFICIENT_OBSERVATION');
    assert.strictEqual(result.delta, null);
    assert.strictEqual(result.direction, null);
  });
});
