'use strict';

// trust-profile.test.js — ENG-014 WP-7. Tests the route handlers directly
// (mirrors benchmarks.test.js's factory + fakeRes convention) — no live
// server, no live DB.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createGetCurrentAuthenticated,
  createGetCurrentPublic,
  createGetHistory,
  createGetChange,
} = require('./trust-profile');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function instance(overrides = {}) {
  return {
    organisationId: 'ORG-1',
    organisationDomains: ['example.com'],
    generatedAt: '2026-07-01T00:00:00.000Z',
    trigger: 'scheduled',
    provenanceVector: {},
    provenanceManifest: {},
    trustScore: { value: 750, band: 'Good', earned: 700, attainable: 900, completeness: 0.9, coreComplete: false, observedSignalCount: 1 },
    componentBreakdown: [{ id: 'spf', category: 'A', weight: 900, observed: true, earned: 700 }],
    categoryScores: { A: { earned: 700, attainable: 900 } },
    ...overrides,
  };
}

describe('GET /:id (authenticated) — three-outcome contract', () => {
  test('(a) current instance exists → 200, full instance in Authenticated Projection', async () => {
    const handler = createGetCurrentAuthenticated({ getCurrent: async () => ({ exists: true, instance: instance() }) });
    const res = fakeRes();
    await handler({ params: { id: 'ORG-1' }, query: {} }, res, () => assert.fail());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.generated, false);
    assert.strictEqual(res.body.trustProfile.organisationId, 'ORG-1');
    assert.strictEqual(res.body.trustProfile.trustScore.value, 750);
  });

  test('(b) none exists, no ?generate → explicit 404 "not yet generated", never silent/empty', async () => {
    const handler = createGetCurrentAuthenticated({ getCurrent: async () => ({ exists: false }) });
    const res = fakeRes();
    await handler({ params: { id: 'ORG-1' }, query: {} }, res, () => assert.fail());
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.generated, false);
    assert.ok(res.body.error);
  });

  test('(c) none exists, ?generate=true → synchronous generation, 201, distinguishable from (a)', async () => {
    let saved = null;
    const handler = createGetCurrentAuthenticated({
      getCurrent: async () => ({ exists: false }),
      generateTrustProfile: async (id, opts) => instance({ organisationId: id, ...opts }),
      save: async (i) => { saved = i; },
      now: () => '2026-07-13T00:00:00.000Z',
    });
    const res = fakeRes();
    await handler({ params: { id: 'ORG-1' }, query: { generate: 'true' } }, res, () => assert.fail());
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.generated, true);
    assert.strictEqual(res.body.trustProfile.trigger, 'on-demand');
    assert.strictEqual(saved.organisationId, 'ORG-1');
  });

  test('the route performs no computation of its own — trustProfile is exactly what getCurrent/generate returned, redacted only', async () => {
    const inst = instance();
    const handler = createGetCurrentAuthenticated({ getCurrent: async () => ({ exists: true, instance: inst }) });
    const res = fakeRes();
    await handler({ params: { id: 'ORG-1' }, query: {} }, res, () => assert.fail());
    assert.strictEqual(res.body.trustProfile.categoryScores, inst.categoryScores);
  });
});

describe('GET /:id/public — Public Projection, OC-7 redaction only', () => {
  test('current instance → Public Projection, no provenance/categoryScores', async () => {
    const handler = createGetCurrentPublic({ getCurrent: async () => ({ exists: true, instance: instance() }) });
    const res = fakeRes();
    await handler({ params: { id: 'ORG-1' } }, res, () => assert.fail());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.trustProfile.headlineScore, 750);
    assert.strictEqual(res.body.trustProfile.provenanceVector, undefined);
    assert.strictEqual(res.body.trustProfile.categoryScores, undefined);
  });

  test('not yet generated → 404, never an error, never silent', async () => {
    const handler = createGetCurrentPublic({ getCurrent: async () => ({ exists: false }) });
    const res = fakeRes();
    await handler({ params: { id: 'ORG-1' } }, res, () => assert.fail());
    assert.strictEqual(res.statusCode, 404);
  });

  test('Public and Authenticated, read against the same instance, differ only by redaction (IT-9)', async () => {
    const inst = instance();
    const pubHandler = createGetCurrentPublic({ getCurrent: async () => ({ exists: true, instance: inst }) });
    const authHandler = createGetCurrentAuthenticated({ getCurrent: async () => ({ exists: true, instance: inst }) });
    const pubRes = fakeRes();
    const authRes = fakeRes();
    await pubHandler({ params: { id: 'ORG-1' } }, pubRes, () => assert.fail());
    await authHandler({ params: { id: 'ORG-1' }, query: {} }, authRes, () => assert.fail());
    assert.strictEqual(pubRes.body.trustProfile.headlineScore, authRes.body.trustProfile.trustScore.value);
  });
});

describe('GET /:id/history', () => {
  test('returns the full retained sequence, oldest-first, each redacted to Authenticated shape', async () => {
    const handler = createGetHistory({
      getHistory: async () => [
        { generatedAt: '2026-07-01T00:00:00.000Z', instance: instance({ generatedAt: '2026-07-01T00:00:00.000Z' }) },
        { generatedAt: '2026-07-10T00:00:00.000Z', instance: instance({ generatedAt: '2026-07-10T00:00:00.000Z' }) },
      ],
    });
    const res = fakeRes();
    await handler({ params: { id: 'ORG-1' } }, res, () => assert.fail());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.history.length, 2);
    assert.strictEqual(res.body.history[0].generatedAt, '2026-07-01T00:00:00.000Z');
  });
});

describe('GET /:id/change', () => {
  test('delegates to getHistory + computeChangeIndicator, wraps in { success, organisationId, change }', async () => {
    const calledWith = [];
    const handler = createGetChange({
      getHistory: async (id) => { calledWith.push(id); return ['fake-history']; },
      computeChangeIndicator: (history) => {
        assert.deepStrictEqual(history, ['fake-history']);
        return { status: 'ok', current: 750, previous: 700, delta: 50, direction: 'up' };
      },
    });
    const res = fakeRes();
    await handler({ params: { id: 'ORG-1' } }, res, () => assert.fail());

    assert.deepStrictEqual(calledWith, ['ORG-1']);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, {
      success: true,
      organisationId: 'ORG-1',
      change: { status: 'ok', current: 750, previous: 700, delta: 50, direction: 'up' },
    });
  });

  test('no history → change status "no-data", still 200', async () => {
    const handler = createGetChange({ getHistory: async () => [] });
    const res = fakeRes();
    await handler({ params: { id: 'ORG-1' } }, res, () => assert.fail());
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.change, { status: 'no-data' });
  });

  test('a DB failure surfaces via next(err), not a crash', async () => {
    const boom = new Error('db unreachable');
    const handler = createGetChange({ getHistory: async () => { throw boom; } });
    const res = fakeRes();
    let caught;
    await handler({ params: { id: 'ORG-1' } }, res, (err) => { caught = err; });
    assert.strictEqual(caught, boom);
  });
});
