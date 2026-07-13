'use strict';

// compliance-evidence.test.js — tests each route handler in isolation via
// its DI factory (no HTTP server, no supertest; mirrors trust-profile.test.js
// and portfolio.test.js's style). requireAuth/attachTenant/requireTenant/
// requirePortfolio are covered by their own test files.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createPostComplianceEvidence, createGetComplianceEvidence } = require('./compliance-evidence');
const { ValidationError } = require('../../infra/utils/errors');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function fakeNext() {
  const calls = [];
  const next = (...args) => calls.push(args);
  return { next, calls };
}

const tenantReq = (overrides = {}) => ({
  user: { id: 'user-1', email: 'jane@smithllp.co.uk', role: 'customer' },
  tenant: { id: 'm1', tenantRole: 'owner', customer: { id: 'cust-1', name: 'Smith LLP' } },
  params: { organisationId: 'ORG-1' },
  body: {},
  ...overrides,
});

describe('POST /:organisationId — createPostComplianceEvidence', () => {
  test('records a review, server-deriving reviewedByUserId/customerId/trustProfileGeneratedAt — never trusting the request body for them', async () => {
    let recorded = null;
    const handler = createPostComplianceEvidence({
      recordEvent: async (event) => { recorded = event; return { id: 'evt-1', ...event, reviewedAt: '2026-07-13T00:00:00.000Z' }; },
      getCurrent: async () => ({ exists: true, generatedAt: '2026-07-10T00:00:00.000Z' }),
    });
    const res = fakeRes();

    await handler(
      tenantReq({ body: { note: 'Called the client, DMARC now enforced.', reviewedByUserId: 'attacker-supplied', customerId: 'attacker-supplied' } }),
      res,
      () => assert.fail(),
    );

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(recorded.organisationId, 'ORG-1');
    assert.strictEqual(recorded.customerId, 'cust-1'); // from req.tenant, not the body
    assert.strictEqual(recorded.reviewedByUserId, 'user-1'); // from req.user, not the body
    assert.strictEqual(recorded.trustProfileGeneratedAt, '2026-07-10T00:00:00.000Z');
    assert.strictEqual(recorded.note, 'Called the client, DMARC now enforced.');
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.event.id, 'evt-1');
  });

  test('defaults type to review_completed and rejects any other value', async () => {
    const handler = createPostComplianceEvidence({
      recordEvent: async (event) => ({ id: 'evt-1', ...event }),
      getCurrent: async () => ({ exists: false }),
    });
    const res = fakeRes();
    await handler(tenantReq({ body: {} }), res, () => assert.fail());
    assert.strictEqual(res.body.event.type, 'review_completed');

    const { next, calls } = fakeNext();
    await handler(tenantReq({ body: { type: 'something_else' } }), fakeRes(), next);
    assert.ok(calls[0][0] instanceof ValidationError);
  });

  test('trustProfileGeneratedAt is honestly null when no Trust Profile Instance exists yet — never fabricated', async () => {
    let recorded = null;
    const handler = createPostComplianceEvidence({
      recordEvent: async (event) => { recorded = event; return { id: 'evt-1', ...event }; },
      getCurrent: async () => ({ exists: false }),
    });
    await handler(tenantReq(), fakeRes(), () => assert.fail());
    assert.strictEqual(recorded.trustProfileGeneratedAt, null);
  });

  test('a non-string note is rejected as a ValidationError', async () => {
    const handler = createPostComplianceEvidence({ recordEvent: async () => ({}), getCurrent: async () => ({ exists: false }) });
    const { next, calls } = fakeNext();
    await handler(tenantReq({ body: { note: 12345 } }), fakeRes(), next);
    assert.ok(calls[0][0] instanceof ValidationError);
  });

  test('a DB failure surfaces via next(err), not a crash', async () => {
    const boom = new Error('db unreachable');
    const handler = createPostComplianceEvidence({
      recordEvent: async () => { throw boom; },
      getCurrent: async () => ({ exists: false }),
    });
    const { next, calls } = fakeNext();
    await handler(tenantReq(), fakeRes(), next);
    assert.strictEqual(calls[0][0], boom);
  });
});

describe('GET /:organisationId — createGetComplianceEvidence', () => {
  test('returns the event list for the requested organisation', async () => {
    const events = [{ id: 'evt-1', organisationId: 'ORG-1', reviewedAt: '2026-07-10T00:00:00.000Z', type: 'review_completed', note: null }];
    const handler = createGetComplianceEvidence({ getEvents: async (id) => (id === 'ORG-1' ? events : []) });
    const res = fakeRes();

    await handler(tenantReq(), res, () => assert.fail());

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true, events });
  });

  test('an organisation never reviewed → empty array, 200, never an error', async () => {
    const handler = createGetComplianceEvidence({ getEvents: async () => [] });
    const res = fakeRes();
    await handler(tenantReq(), res, () => assert.fail());
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.events, []);
  });

  test('a DB failure surfaces via next(err), not a crash', async () => {
    const boom = new Error('db unreachable');
    const handler = createGetComplianceEvidence({ getEvents: async () => { throw boom; } });
    const { next, calls } = fakeNext();
    await handler(tenantReq(), fakeRes(), next);
    assert.strictEqual(calls[0][0], boom);
  });
});
