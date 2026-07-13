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
  createGetReportPdf,
  createGetRecommendations,
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

// GET /:id/report.pdf — Compliance Advisor MVP (ENG-047/ENG-048).
describe('GET /:id/report.pdf', () => {
  function fakePdfRes() {
    const res = { statusCode: 200, headers: {}, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    res.setHeader = (name, value) => { res.headers[name] = value; };
    res.send = (buf) => { res.body = buf; return res; };
    return res;
  }

  test('renders a PDF for an existing instance, never recomputing or calling generateTrustProfile', async () => {
    let generateCalled = false;
    let capturedInstance = null;
    const handler = createGetReportPdf({
      getCurrent: async () => ({ exists: true, instance: instance() }),
      generateTrustProfile: async () => { generateCalled = true; },
      reverse: () => ({ ok: true, row: { organisationName: 'Test Solicitors LLP' } }),
      generateTrustProfilePdf: async (args) => { capturedInstance = args.instance; return Buffer.from('%PDF-fake'); },
    });
    const res = fakePdfRes();
    await handler({ params: { id: 'ORG-1' }, query: {}, tenant: { customer: { name: 'Acme Compliance' } } }, res, () => assert.fail());

    assert.strictEqual(generateCalled, false);
    assert.strictEqual(capturedInstance.organisationId, 'ORG-1');
    assert.strictEqual(res.headers['Content-Type'], 'application/pdf');
    assert.match(res.headers['Content-Disposition'], /trust-profile-ORG-1\.pdf/);
    assert.ok(Buffer.isBuffer(res.body));
  });

  test('404 when no instance exists and ?generate is not set', async () => {
    const handler = createGetReportPdf({ getCurrent: async () => ({ exists: false }) });
    const res = fakePdfRes();
    await handler({ params: { id: 'ORG-1' }, query: {}, tenant: null }, res, () => assert.fail());
    assert.strictEqual(res.statusCode, 404);
  });

  test('?generate=true synchronously generates, saves, then renders the PDF from that instance', async () => {
    let saved = null;
    const handler = createGetReportPdf({
      getCurrent: async () => ({ exists: false }),
      generateTrustProfile: async (id, opts) => instance({ organisationId: id, generatedAt: opts.generatedAt }),
      save: async (inst) => { saved = inst; },
      reverse: () => ({ ok: true, row: { organisationName: 'New Firm LLP' } }),
      generateTrustProfilePdf: async (args) => Buffer.from(`%PDF-${args.organisationName}`),
      now: () => '2026-07-13T00:00:00.000Z',
    });
    const res = fakePdfRes();
    await handler({ params: { id: 'ORG-2' }, query: { generate: 'true' }, tenant: null }, res, () => assert.fail());

    assert.ok(saved);
    assert.strictEqual(saved.organisationId, 'ORG-2');
    assert.strictEqual(res.body.toString(), '%PDF-New Firm LLP');
  });

  test('falls back to the organisationId as the display name when Repository Authority lookup fails', async () => {
    let capturedName = null;
    const handler = createGetReportPdf({
      getCurrent: async () => ({ exists: true, instance: instance() }),
      reverse: () => ({ ok: false, error: 'not found' }),
      generateTrustProfilePdf: async (args) => { capturedName = args.organisationName; return Buffer.from('%PDF'); },
    });
    const res = fakePdfRes();
    await handler({ params: { id: 'ORG-1' }, query: {}, tenant: null }, res, () => assert.fail());
    assert.strictEqual(capturedName, 'ORG-1');
  });

  test('a DB failure surfaces via next(err), not a crash', async () => {
    const boom = new Error('db unreachable');
    const handler = createGetReportPdf({ getCurrent: async () => { throw boom; } });
    const res = fakePdfRes();
    let caught;
    await handler({ params: { id: 'ORG-1' }, query: {}, tenant: null }, res, (err) => { caught = err; });
    assert.strictEqual(caught, boom);
  });
});

// GET /:id/recommendations — Recommendation Derivation (ADR-SYS-012, draft
// ENG-044). Mirrors GET /:id/change's shape: the route performs no
// computation of its own, it delegates entirely to
// recommendation-derivation.js's pure deriveRecommendations().
describe('GET /:id/recommendations', () => {
  test('delegates to getCurrent + deriveRecommendations, wraps the derivation result in { success }', async () => {
    const inst = instance({ componentBreakdown: [{ id: 'spf', category: 'A', weight: 100, observed: true, earned: 20 }] });
    let derivedFrom = null;
    const handler = createGetRecommendations({
      getCurrent: async () => ({ exists: true, instance: inst }),
      deriveRecommendations: (passedInstance) => {
        derivedFrom = passedInstance;
        return { organisationId: 'ORG-1', trustProfileGeneratedAt: inst.generatedAt, derivationVersion: 'REC-DERIVE-v1.0', recommendations: [{ componentId: 'spf' }] };
      },
    });
    const res = fakeRes();

    await handler({ params: { id: 'ORG-1' } }, res, () => assert.fail());

    assert.strictEqual(derivedFrom, inst);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.derivationVersion, 'REC-DERIVE-v1.0');
    assert.strictEqual(res.body.recommendations.length, 1);
  });

  test('not yet generated → 404, never a silent empty array standing in for "no instance"', async () => {
    const handler = createGetRecommendations({ getCurrent: async () => ({ exists: false }) });
    const res = fakeRes();
    await handler({ params: { id: 'ORG-1' } }, res, () => assert.fail());
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.success, false);
  });

  test('a DB failure surfaces via next(err), not a crash', async () => {
    const boom = new Error('db unreachable');
    const handler = createGetRecommendations({ getCurrent: async () => { throw boom; } });
    const res = fakeRes();
    let caught;
    await handler({ params: { id: 'ORG-1' } }, res, (err) => { caught = err; });
    assert.strictEqual(caught, boom);
  });
});
