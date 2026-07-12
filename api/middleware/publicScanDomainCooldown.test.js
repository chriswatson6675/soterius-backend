'use strict';

// publicScanDomainCooldown.test.js — T1.3 (ENG-013 WP1). DI/fake client
// style, matching this repo's existing convention (client injected, default
// getClient()). No real Supabase connection is made.

const { test } = require('node:test');
const assert = require('node:assert');

const { createDomainCooldownCheck, normaliseDomain } = require('./publicScanDomainCooldown');

// A minimal fake of the chainable Supabase/PostgREST query builder used by
// this module: .from().select().eq().filter().gte().order().limit() then
// awaited. Each call returns `this`; awaiting the chain resolves to the
// injected { data, error }.
function fakeClient(result) {
  const calls = [];
  const chain = {
    from(table) { calls.push(['from', table]); return chain; },
    select(...args) { calls.push(['select', ...args]); return chain; },
    eq(...args) { calls.push(['eq', ...args]); return chain; },
    filter(...args) { calls.push(['filter', ...args]); return chain; },
    gte(...args) { calls.push(['gte', ...args]); return chain; },
    order(...args) { calls.push(['order', ...args]); return chain; },
    limit(...args) { calls.push(['limit', ...args]); return chain; },
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

test('normaliseDomain trims, lowercases, and strips scheme/www/path — no format validation', () => {
  assert.strictEqual(normaliseDomain('https://www.Example.com/path?x=1'), 'example.com');
  assert.strictEqual(normaliseDomain('  EXAMPLE.COM  '), 'example.com');
  assert.strictEqual(normaliseDomain(''), null);
  assert.strictEqual(normaliseDomain(null), null);
  assert.strictEqual(normaliseDomain(42), null);
});

test('no domain in body — passes through, leaves rejection to the route handler', async () => {
  const { client } = fakeClient({ data: [], error: null });
  const check = createDomainCooldownCheck({ client });
  const req = { body: {} };
  const res = fakeRes();
  let nextCalled = false;

  await check(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});

test('no recent session — calls next(), does not respond', async () => {
  const { client, calls } = fakeClient({ data: [], error: null });
  const check = createDomainCooldownCheck({ client });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();
  let nextCalled = false;

  await check(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
  assert.ok(calls.some(([op, table]) => op === 'from' && table === 'observation_sessions'));
  assert.ok(calls.some(([op, ...args]) => op === 'eq' && args[0] === 'trigger' && args[1] === 'on-demand'));
  assert.ok(calls.some(([op, ...args]) => op === 'filter' && args[0] === 'scope->>domain' && args[2] === 'example.com'));
});

test('recent completed session — cache-hit, 200, orchestrator never invoked', async () => {
  const { client } = fakeClient({
    data: [{ id: 'sess-1', status: 'completed', created_at: new Date().toISOString(), scope: { domain: 'example.com' } }],
    error: null,
  });
  const check = createDomainCooldownCheck({ client });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();
  let nextCalled = false;

  await check(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.cached, true);
  assert.strictEqual(res.body.sessionId, 'sess-1');
});

test('recent partial session — also treated as a cache-hit', async () => {
  const { client } = fakeClient({
    data: [{ id: 'sess-2', status: 'partial', created_at: new Date().toISOString(), scope: { domain: 'example.com' } }],
    error: null,
  });
  const check = createDomainCooldownCheck({ client });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();
  let nextCalled = false;

  await check(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.cached, true);
});

test('recent running session — 202, points at the existing session, does not start a second run', async () => {
  const { client } = fakeClient({
    data: [{ id: 'sess-3', status: 'running', created_at: new Date().toISOString(), scope: { domain: 'example.com' } }],
    error: null,
  });
  const check = createDomainCooldownCheck({ client });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();
  let nextCalled = false;

  await check(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.sessionId, 'sess-3');
});

test('recent queued session — also treated as in-progress (202)', async () => {
  const { client } = fakeClient({
    data: [{ id: 'sess-4', status: 'queued', created_at: new Date().toISOString(), scope: { domain: 'example.com' } }],
    error: null,
  });
  const check = createDomainCooldownCheck({ client });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();
  let nextCalled = false;

  await check(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 202);
});

test('recent failed session — rejected with 429 + Retry-After, no result to serve', async () => {
  const { client } = fakeClient({
    data: [{ id: 'sess-5', status: 'failed', created_at: new Date().toISOString(), scope: { domain: 'example.com' } }],
    error: null,
  });
  const check = createDomainCooldownCheck({ client });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();
  let nextCalled = false;

  await check(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(res.body.success, false);
  assert.ok(res.headers['Retry-After']);
});

test('recent cancelled session — also rejected with 429', async () => {
  const { client } = fakeClient({
    data: [{ id: 'sess-6', status: 'cancelled', created_at: new Date().toISOString(), scope: { domain: 'example.com' } }],
    error: null,
  });
  const check = createDomainCooldownCheck({ client });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();
  let nextCalled = false;

  await check(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(res.statusCode, 429);
});

test('a query error fails open — calls next(), never blocks the caller on an infra hiccup', async () => {
  const { client } = fakeClient({ data: null, error: { message: 'connection reset' } });
  const check = createDomainCooldownCheck({ client });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();
  let nextCalled = false;

  await check(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.statusCode, null);
});
