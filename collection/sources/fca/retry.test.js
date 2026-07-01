'use strict';

// retry.test.js — Phase 7 retry tests (IMP-FCA-001 §7).

const { test } = require('node:test');
const assert = require('node:assert');
const { withRetry, classifyOutcome, backoffMs } = require('./retry');

const R = (errorType, httpStatus) => ({ errorType, httpStatus: httpStatus ?? null, fsrStatus: null, errorMessage: errorType === 'NONE' ? null : errorType });
const HELP = { _sleep: async () => {}, _now: () => 'T' }; // no real delay, deterministic

test('classifyOutcome: success / transient / permanent', () => {
  assert.strictEqual(classifyOutcome(R('NONE')), 'success');
  assert.strictEqual(classifyOutcome(R('CONNECTION_ERROR')), 'transient');
  assert.strictEqual(classifyOutcome(R('RATE_LIMITED', 429)), 'transient');
  assert.strictEqual(classifyOutcome(R('HTTP_ERROR', 503)), 'transient');
  assert.strictEqual(classifyOutcome(R('HTTP_ERROR', 404)), 'permanent');
  assert.strictEqual(classifyOutcome(R('PARSE_ERROR')), 'permanent');
});

test('retries a transient failure then succeeds; every attempt recorded', async () => {
  let n = 0;
  const { attempts, final } = await withRetry(async () => { n++; return n < 3 ? R('CONNECTION_ERROR') : R('NONE'); }, { maxAttempts: 5 }, HELP);
  assert.strictEqual(attempts.length, 3);
  assert.deepStrictEqual(attempts.map((a) => a.outcome), ['transient', 'transient', 'success']);
  assert.strictEqual(final.errorType, 'NONE');
});

test('does NOT retry a permanent failure', async () => {
  let n = 0;
  const { attempts, final } = await withRetry(async () => { n++; return R('HTTP_ERROR', 404); }, { maxAttempts: 5 }, HELP);
  assert.strictEqual(attempts.length, 1);
  assert.strictEqual(n, 1);
  assert.strictEqual(final.httpStatus, 404);
});

test('bounded: stops at maxAttempts when failures persist', async () => {
  let n = 0;
  const { attempts, final } = await withRetry(async () => { n++; return R('RATE_LIMITED', 429); }, { maxAttempts: 3 }, HELP);
  assert.strictEqual(attempts.length, 3);
  assert.strictEqual(n, 3);
  assert.strictEqual(final.errorType, 'RATE_LIMITED');
});

test('success on first attempt = single attempt (no retry)', async () => {
  const { attempts } = await withRetry(async () => R('NONE'), { maxAttempts: 3 }, HELP);
  assert.strictEqual(attempts.length, 1);
});

test('an FCA absence (NONE transport) is success, never retried', async () => {
  // observed-absence is HTTP 200 / errorType NONE → transport success; not retried.
  let n = 0;
  const { attempts } = await withRetry(async () => { n++; return { errorType: 'NONE', httpStatus: 200, fsrStatus: 'FSR-API-02-13-11' }; }, { maxAttempts: 3 }, HELP);
  assert.strictEqual(attempts.length, 1);
});

test('backoff is exponential and capped', () => {
  const pol = { baseDelayMs: 500, maxDelayMs: 8000 };
  assert.strictEqual(backoffMs(1, pol), 500);
  assert.strictEqual(backoffMs(2, pol), 1000);
  assert.strictEqual(backoffMs(3, pol), 2000);
  assert.strictEqual(backoffMs(20, pol), 8000); // capped
});
