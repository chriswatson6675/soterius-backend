'use strict';

// prospects.test.js — T3.3/T3.4 (ENG-013 WP3). DI/fake style, matching
// observation-sessions.test.js for the two migrated on-demand handlers
// (fire-and-forget promise chains, not directly awaited — the same shape
// createOnDemandHandler uses) and portfolio.test.js for the benchmarks
// route. requireAdmin is not covered here (a trivial header check).

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createQuickScanHandler, createProspectScanHandler, createGetProspectBenchmarks,
} = require('./prospects');
const { ValidationError, AppError } = require('../../infra/utils/errors');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function fakeNext() {
  const calls = [];
  return { next: (...args) => calls.push(args), calls };
}

function flush() {
  return new Promise((r) => setImmediate(r));
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ── POST /api/prospects/quick-scan (T3.4) ───────────────────────────────────

test('quick-scan: website is required — 400, no prospect lookup, no orchestrator call', async () => {
  let findCalled = false;
  let runCalled = false;
  const handler = createQuickScanHandler({
    findOrCreateProspectFn: async () => { findCalled = true; return { success: true, prospect: {} }; },
    runOnDemand: async () => { runCalled = true; return { ok: true }; },
  });
  const req = { body: {} };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  handler(req, res, next);
  await flush();

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0] instanceof ValidationError);
  assert.strictEqual(findCalled, false);
  assert.strictEqual(runCalled, false);
});

test('quick-scan: invalid website domain — 400, no orchestrator call', async () => {
  let runCalled = false;
  const handler = createQuickScanHandler({
    runOnDemand: async () => { runCalled = true; return { ok: true }; },
  });
  const req = { body: { website: 'localhost' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  handler(req, res, next);
  await flush();

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0] instanceof ValidationError);
  assert.strictEqual(runCalled, false);
});

test('quick-scan: finds/creates the prospect then triggers the canonical on-demand orchestrator — never the legacy executeScan', async () => {
  const gate = deferred();
  let receivedDomain = null;
  const lastScannedCalls = [];
  const handler = createQuickScanHandler({
    findOrCreateProspectFn: async (data) => ({ success: true, created: true, prospect: { id: 'p1', firm_name: data.firm_name } }),
    updateProspectLastScannedFn: async (id) => { lastScannedCalls.push(id); },
    runOnDemand: (domain, opts) => {
      receivedDomain = domain;
      opts.onSessionCreated({ id: 'session-1' });
      return gate.promise;
    },
  });
  const req = { body: { website: 'https://Example.com/', firm_name: 'Example LLP' } };
  const res = fakeRes();
  const { next } = fakeNext();

  handler(req, res, next);
  await flush();
  gate.resolve({ ok: true, sessionId: 'session-1' });
  await flush();

  assert.strictEqual(receivedDomain, 'example.com');
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.sessionId, 'session-1');
  assert.strictEqual(res.body.prospectId, 'p1');
  assert.deepStrictEqual(lastScannedCalls, ['p1']);
});

test('quick-scan: prospect creation failure — 500 via next(), orchestrator never invoked', async () => {
  let runCalled = false;
  const handler = createQuickScanHandler({
    findOrCreateProspectFn: async () => ({ success: false, error: 'db error' }),
    runOnDemand: async () => { runCalled = true; return { ok: true }; },
  });
  const req = { body: { website: 'example.com' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  handler(req, res, next);
  await flush();

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0] instanceof AppError);
  assert.strictEqual(runCalled, false);
});

test('quick-scan: session-creation failure — 502, never a silent hang', async () => {
  const handler = createQuickScanHandler({
    findOrCreateProspectFn: async () => ({ success: true, created: true, prospect: { id: 'p1', firm_name: 'X' } }),
    runOnDemand: async () => ({ ok: false, error: 'db unreachable' }), // onSessionCreated never fires
  });
  const req = { body: { website: 'example.com' } };
  const res = fakeRes();
  const { next } = fakeNext();

  handler(req, res, next);
  await flush();
  await flush();

  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.success, false);
});

// ── POST /api/prospects/:id/scan (T3.4) ──────────────────────────────────────

test('prospect scan: unknown prospect id — 404, orchestrator never invoked', async () => {
  let runCalled = false;
  const handler = createProspectScanHandler({
    getProspectByIdFn: async () => null,
    runOnDemand: async () => { runCalled = true; return { ok: true }; },
  });
  const req = { params: { id: 'missing' } };
  const res = fakeRes();
  const { next } = fakeNext();

  handler(req, res, next);
  await flush();

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(runCalled, false);
});

test('prospect scan: prospect with an invalid stored domain — rejected via next(), orchestrator never invoked', async () => {
  let runCalled = false;
  const handler = createProspectScanHandler({
    getProspectByIdFn: async () => ({ id: 'p1', firm_name: 'X', website: 'localhost' }),
    runOnDemand: async () => { runCalled = true; return { ok: true }; },
  });
  const req = { params: { id: 'p1' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  handler(req, res, next);
  await flush();

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0] instanceof ValidationError);
  assert.strictEqual(runCalled, false);
});

test('prospect scan: triggers the canonical on-demand orchestrator for the prospect\'s domain', async () => {
  const lastScannedCalls = [];
  const handler = createProspectScanHandler({
    getProspectByIdFn: async () => ({ id: 'p1', firm_name: 'Example LLP', website: 'example.com' }),
    updateProspectLastScannedFn: async (id) => { lastScannedCalls.push(id); },
    runOnDemand: (domain, opts) => {
      opts.onSessionCreated({ id: 'session-2' });
      return Promise.resolve({ ok: true, sessionId: 'session-2' });
    },
  });
  const req = { params: { id: 'p1' } };
  const res = fakeRes();
  const { next } = fakeNext();

  handler(req, res, next);
  await flush();

  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.sessionId, 'session-2');
  assert.deepStrictEqual(lastScannedCalls, ['p1']);
});

// ── GET /api/prospects/benchmarks (T3.3) ─────────────────────────────────────

test('prospect benchmarks: delegates to the shared aggregation, preserving the { success, byLocation } response shape', async () => {
  const raw = [
    { overall_score: 80, risk_band: 'Good', prospects: { sector: 'Legal', location: 'London' }, scanner_results: [] },
  ];
  const getBenchmarks = createGetProspectBenchmarks(async () => raw);
  const req = {};
  const res = fakeRes();
  const next = () => assert.fail('next() should not be called');

  await getBenchmarks(req, res, next);

  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.totalScans, 1);
  assert.ok(Array.isArray(res.body.byLocation));
  assert.strictEqual(res.body.signalAdoption, undefined); // prospects.js's own response never included this
});
