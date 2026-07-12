'use strict';

// observation-sessions.test.js — tests POST /on-demand in isolation (no HTTP
// server, no supertest; matches this codebase's DI + fake req/res style —
// me.test.js, requireAuth.test.js). requireAuth is covered by its own tests;
// this file assumes it already ran and populated req.user.

const { test } = require('node:test');
const assert = require('node:assert');

const { createOnDemandHandler } = require('./observation-sessions');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ── Input validation — never reaches the orchestrator ───────────────────────

test('missing domain — 400, orchestrator never called', () => {
  let called = false;
  const handler = createOnDemandHandler(async () => { called = true; return { ok: true }; });
  const req = { body: {}, user: { id: 'u1' } };
  const res = fakeRes();

  handler(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(called, false);
});

test('SSRF-blocked domain (e.g. localhost) — 400, orchestrator never called', () => {
  let called = false;
  const handler = createOnDemandHandler(async () => { called = true; return { ok: true }; });
  const req = { body: { domain: 'localhost' }, user: { id: 'u1' } };
  const res = fakeRes();

  handler(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /Invalid domain/);
  assert.strictEqual(called, false);
});

test('domain is normalised (scheme/www/path stripped) before reaching the orchestrator', async () => {
  let receivedDomain = null;
  const gate = deferred();
  const handler = createOnDemandHandler(async (domain, opts) => {
    receivedDomain = domain;
    opts.onSessionCreated({ id: 'session-1' });
    return gate.promise;
  });
  const req = { body: { domain: 'https://www.Example.com/path' }, user: { id: 'u1' } };
  const res = fakeRes();

  handler(req, res);
  gate.resolve({ ok: true });
  await Promise.resolve();

  assert.strictEqual(receivedDomain, 'example.com');
});

// ── 202 returns as soon as the session exists, never waits for completion ──

test('returns 202 with sessionId as soon as onSessionCreated fires — before the pipeline resolves', async () => {
  const gate = deferred();
  const handler = createOnDemandHandler((domain, opts) => {
    opts.onSessionCreated({ id: 'session-42' });
    return gate.promise; // still pending — proves the response did not wait for this
  });
  const req = { body: { domain: 'example.com' }, user: { id: 'u1' } };
  const res = fakeRes();

  handler(req, res);
  await Promise.resolve(); // let the synchronous onSessionCreated call land

  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.sessionId, 'session-42');
  assert.strictEqual(res.body.domain, 'example.com');

  gate.resolve({ ok: true, sessionId: 'session-42', signals: [] }); // cleans up the pending promise
});

test('requestedBy is passed through from req.user.id', async () => {
  let receivedOpts = null;
  const gate = deferred();
  const handler = createOnDemandHandler((domain, opts) => {
    receivedOpts = opts;
    opts.onSessionCreated({ id: 's1' });
    return gate.promise;
  });
  const req = { body: { domain: 'example.com' }, user: { id: 'user-abc' } };
  const res = fakeRes();

  handler(req, res);
  gate.resolve({ ok: true });
  await Promise.resolve();

  assert.strictEqual(receivedOpts.requestedBy, 'user-abc');
});

test('no req.user (defensive — requireAuth should already have rejected this) sends requestedBy: null, not a crash', async () => {
  let receivedOpts = null;
  const gate = deferred();
  const handler = createOnDemandHandler((domain, opts) => {
    receivedOpts = opts;
    opts.onSessionCreated({ id: 's1' });
    return gate.promise;
  });
  const req = { body: { domain: 'example.com' } };
  const res = fakeRes();

  handler(req, res);
  gate.resolve({ ok: true });
  await Promise.resolve();

  assert.strictEqual(receivedOpts.requestedBy, null);
});

// ── Session creation failure — the one path that reaches .then() unresponded ─

test('session creation failure (hook never fires) — 502, reported once the promise resolves', async () => {
  const handler = createOnDemandHandler(async () => ({ ok: false, error: 'db unreachable' }));
  const req = { body: { domain: 'example.com' }, user: { id: 'u1' } };
  const res = fakeRes();

  handler(req, res);
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.success, false);
});

test('a rejected orchestrator promise — 502, not an unhandled rejection', async () => {
  const handler = createOnDemandHandler(async () => { throw new Error('unexpected'); });
  const req = { body: { domain: 'example.com' }, user: { id: 'u1' } };
  const res = fakeRes();

  handler(req, res);
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(res.statusCode, 502);
});

test('a late orchestrator failure AFTER 202 was already sent does not attempt a second response', async () => {
  const gate = deferred();
  const handler = createOnDemandHandler((domain, opts) => {
    opts.onSessionCreated({ id: 's1' });
    return gate.promise;
  });
  const req = { body: { domain: 'example.com' }, user: { id: 'u1' } };
  const res = fakeRes();

  handler(req, res);
  await Promise.resolve();
  assert.strictEqual(res.statusCode, 202);

  gate.resolve({ ok: false, error: 'a signal collector exploded mid-pipeline', sessionId: 's1' });
  await new Promise((r) => setImmediate(r));

  // statusCode must still be 202 — no second res.status()/res.json() call
  // overwrote the already-sent response.
  assert.strictEqual(res.statusCode, 202);
});
