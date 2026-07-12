'use strict';

// publicScanConcurrencyGuard.test.js — T1.4 (ENG-013 WP1). DI/fake client
// style, matching this repo's existing convention.

const { test } = require('node:test');
const assert = require('node:assert');

const { createConcurrencyGuard, CONCURRENCY_CEILING } = require('./publicScanConcurrencyGuard');

function fakeClient(result) {
  const calls = [];
  const chain = {
    from(table) { calls.push(['from', table]); return chain; },
    select(...args) { calls.push(['select', ...args]); return chain; },
    eq(...args) { calls.push(['eq', ...args]); return chain; },
    then(resolve) { resolve(result); },
  };
  return { client: chain, calls };
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.set = (name, value) => { res.headers[name] = value; return res; };
  return res;
}

test('under the ceiling — calls next(), does not respond', async () => {
  const { client, calls } = fakeClient({ count: CONCURRENCY_CEILING - 1, error: null });
  const guard = createConcurrencyGuard({ client });
  const req = {};
  const res = fakeRes();
  let nextCalled = false;

  await guard(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
  assert.ok(calls.some(([op, table]) => op === 'from' && table === 'observation_sessions'));
  assert.ok(calls.some(([op, ...args]) => op === 'eq' && args[0] === 'trigger' && args[1] === 'on-demand'));
  assert.ok(calls.some(([op, ...args]) => op === 'eq' && args[0] === 'status' && args[1] === 'running'));
});

test('at the ceiling — 503, distinct from the 429 the other two axes use, with Retry-After', async () => {
  const { client } = fakeClient({ count: CONCURRENCY_CEILING, error: null });
  const guard = createConcurrencyGuard({ client });
  const req = {};
  const res = fakeRes();
  let nextCalled = false;

  await guard(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.success, false);
  assert.ok(res.headers['Retry-After']);
});

test('over the ceiling — also 503', async () => {
  const { client } = fakeClient({ count: CONCURRENCY_CEILING + 5, error: null });
  const guard = createConcurrencyGuard({ client });
  const req = {};
  const res = fakeRes();
  let nextCalled = false;

  await guard(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 503);
});

test('a query error fails open — calls next(), never blocks the caller on an infra hiccup', async () => {
  const { client } = fakeClient({ count: null, error: { message: 'timeout' } });
  const guard = createConcurrencyGuard({ client });
  const req = {};
  const res = fakeRes();
  let nextCalled = false;

  await guard(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('null count (no rows) is treated as zero in-flight — never crashes, always calls next()', async () => {
  const { client } = fakeClient({ count: null, error: null });
  const guard = createConcurrencyGuard({ client });
  const req = {};
  const res = fakeRes();
  let nextCalled = false;

  await guard(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
});
