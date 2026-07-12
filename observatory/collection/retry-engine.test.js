'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry, computeBackoff } = require('./retry-engine');

const err = (props) => Object.assign(new Error(props.message || 'x'), props);
// Deterministic no-op sleep that records the delays it was asked to wait.
function recordingSleep() {
  const delays = [];
  return { sleep: async (ms) => { delays.push(ms); }, delays };
}

describe('computeBackoff', () => {
  test('exponential growth without jitter', () => {
    const o = { baseDelayMs: 100, factor: 2, jitter: false, maxDelayMs: 100000 };
    assert.equal(computeBackoff(1, o), 100);
    assert.equal(computeBackoff(2, o), 200);
    assert.equal(computeBackoff(3, o), 400);
    assert.equal(computeBackoff(4, o), 800);
  });
  test('clamps to maxDelayMs', () => {
    assert.equal(computeBackoff(10, { baseDelayMs: 100, factor: 2, jitter: false, maxDelayMs: 1000 }), 1000);
  });
  test('full jitter stays within [0, capped] and uses injected rng', () => {
    assert.equal(computeBackoff(3, { baseDelayMs: 100, factor: 2, jitter: true, rng: () => 0.5 }), 200);
    assert.equal(computeBackoff(3, { baseDelayMs: 100, factor: 2, jitter: true, rng: () => 0 }), 0);
  });
});

describe('withRetry — retryable failures', () => {
  test('retries a transient failure then succeeds; reports attempt count', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const res = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw err({ code: 'ETIMEDOUT' });
      return 'ok';
    }, { maxAttempts: 5, baseDelayMs: 10, factor: 2, jitter: false, sleep });

    assert.equal(res.ok, true);
    assert.equal(res.value, 'ok');
    assert.equal(res.attempts, 3);
    assert.deepEqual(delays, [10, 20]); // two backoffs before the 3rd success
    assert.equal(res.history.length, 2);
    assert.ok(res.history.every((h) => h.retried));
  });

  test('gives up after maxAttempts and returns the final failure', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const res = await withRetry(async () => { calls += 1; throw err({ code: 'ECONNRESET' }); },
      { maxAttempts: 3, baseDelayMs: 10, factor: 2, jitter: false, sleep });

    assert.equal(res.ok, false);
    assert.equal(res.attempts, 3);
    assert.equal(calls, 3);
    assert.equal(res.classification.class, 'RETRYABLE');
    assert.deepEqual(delays, [10, 20]); // no sleep after the final (3rd) attempt
    assert.equal(res.history.length, 3);
    assert.equal(res.history[2].retried, false); // last attempt not retried
  });

  test('onRetry hook fires once per retry with classification + delay', async () => {
    const { sleep } = recordingSleep();
    const seen = [];
    let calls = 0;
    await withRetry(async () => { calls += 1; if (calls < 3) throw err({ code: 'EAI_AGAIN' }); return 1; },
      { maxAttempts: 5, baseDelayMs: 5, jitter: false, sleep, onRetry: (i) => seen.push(i) });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].classification.class, 'RETRYABLE');
    assert.equal(typeof seen[0].delayMs, 'number');
  });
});

describe('withRetry — permanent failures are not retried', () => {
  test('NXDOMAIN fails immediately with a single attempt', async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const res = await withRetry(async () => { calls += 1; throw err({ code: 'ENOTFOUND' }); },
      { maxAttempts: 5, sleep });
    assert.equal(res.ok, false);
    assert.equal(res.attempts, 1);
    assert.equal(calls, 1);
    assert.equal(res.classification.class, 'PERMANENT');
    assert.deepEqual(delays, []);
  });
});

describe('withRetry — unexpected failures are surfaced, not retried', () => {
  test('a programming error stops immediately by default', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const res = await withRetry(async () => { calls += 1; throw new TypeError('bug'); }, { maxAttempts: 5, sleep });
    assert.equal(res.ok, false);
    assert.equal(res.attempts, 1);
    assert.equal(calls, 1);
    assert.equal(res.classification.class, 'UNEXPECTED');
  });

  test('retryUnexpected:true opts into retrying unexpected failures', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const res = await withRetry(async () => { calls += 1; throw new Error('infra wobble'); },
      { maxAttempts: 3, baseDelayMs: 1, jitter: false, sleep, retryUnexpected: true });
    assert.equal(res.attempts, 3);
    assert.equal(calls, 3);
  });
});

describe('withRetry — never throws', () => {
  test('a non-Error thrown value is wrapped and returned, not thrown', async () => {
    const res = await withRetry(async () => { throw 'string failure'; }, { maxAttempts: 1 });
    assert.equal(res.ok, false);
    assert.ok(res.error instanceof Error);
  });
});
