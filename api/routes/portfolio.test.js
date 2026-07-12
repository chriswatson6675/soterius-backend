'use strict';

// portfolio.test.js — tests each route handler in isolation via its DI
// factory (no HTTP server, no supertest; matches me.test.js and the
// middleware test style). requireAuth/attachTenant/requireTenant are
// covered by their own test files — these tests assume req.user/req.tenant
// are already populated, as the middleware chain would set them.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createGetPortfolio, createPostPortfolio, createDeletePortfolio,
} = require('./portfolio');
const { ValidationError, AppError } = require('../../infra/utils/errors');

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
  user:   { id: 'u1', email: 'jane@smithllp.co.uk', role: 'customer' },
  tenant: { id: 'm1', tenantRole: 'owner', customer: { id: 'c1', name: 'Smith LLP' } },
  params: {},
  body:   {},
  ...overrides,
});

// ── GET /api/portfolio ───────────────────────────────────────────────────────

test('getPortfolio — returns a bare array, hydrating each item with its canonical organisation summary', async () => {
  // The DB layer returns ids only (organisation: null); the route resolves the
  // summary through the canonical Organisation layer (the same source as detail).
  const items = [{ id: 'p1', organisationId: 'ORG-000000000001', isHome: true, organisation: null }];
  const summarise = (id) => ({ id, name: 'Smith LLP', domain: 'smithllp.co.uk', sector: null, location: null, lastScannedAt: null });
  const getPortfolio = createGetPortfolio(async (customerId) => (customerId === 'c1' ? items : []), summarise);
  const req = tenantReq();
  const res = fakeRes();

  await getPortfolio(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.body.length, 1);
  assert.strictEqual(res.body[0].organisationId, 'ORG-000000000001');
  assert.deepStrictEqual(res.body[0].organisation, {
    id: 'ORG-000000000001', name: 'Smith LLP', domain: 'smithllp.co.uk', sector: null, location: null, lastScannedAt: null,
  });
});

test('getPortfolio — an unresolvable organisation hydrates to null, not a crash', async () => {
  const items = [{ id: 'p1', organisationId: 'ORG-000000000009', isHome: true, organisation: null }];
  const getPortfolio = createGetPortfolio(async () => items, () => null);
  const res = fakeRes();

  await getPortfolio(tenantReq(), res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.body[0].organisation, null);
});

test('getPortfolio — DB errors go to next(err), not a crash', async () => {
  const boom = new Error('db unreachable');
  const getPortfolio = createGetPortfolio(async () => { throw boom; });
  const { next, calls } = fakeNext();

  await getPortfolio(tenantReq(), fakeRes(), next);

  assert.strictEqual(calls[0][0], boom);
});

// ── POST /api/portfolio ──────────────────────────────────────────────────────

// A valid, resolvable canonical id and an injected reverse() that finds it —
// the happy-path shape for the add tests below.
const VALID_ORG_ID = 'ORG-000000000001';
const reverseFound = (id) => (id === VALID_ORG_ID ? { ok: true, row: { organisationId: id } } : { ok: false, error: 'not found' });

test('postPortfolio — 400 (via next) when organisationId is missing', async () => {
  const postPortfolio = createPostPortfolio(async () => assert.fail('DB should not be called'), () => assert.fail('reverse should not be called'));
  const req = tenantReq({ body: {} });
  const { next, calls } = fakeNext();

  await postPortfolio(req, fakeRes(), next);

  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0] instanceof ValidationError);
});

test('postPortfolio — 400 (via next) when organisationId is not a canonical ORG-* id', async () => {
  // A legacy prospect UUID (or any free text) must be rejected before the DB —
  // this is the F-3 guard that keeps non-canonical ids out of the portfolio.
  const postPortfolio = createPostPortfolio(async () => assert.fail('DB should not be called'), () => assert.fail('reverse should not be called'));
  const req = tenantReq({ body: { organisationId: '550e8400-e29b-41d4-a716-446655440000' } });
  const { next, calls } = fakeNext();

  await postPortfolio(req, fakeRes(), next);

  assert.ok(calls[0][0] instanceof ValidationError);
  assert.match(calls[0][0].message, /canonical ORG-\* identifier/);
});

test('postPortfolio — 404 (via next) when a well-formed id is unknown to Repository Authority', async () => {
  const postPortfolio = createPostPortfolio(
    async () => assert.fail('DB should not be called'),
    () => ({ ok: false, error: 'No organisation known' }),
  );
  const req = tenantReq({ body: { organisationId: 'ORG-ABCDEF012345' } });
  const { next, calls } = fakeNext();

  await postPortfolio(req, fakeRes(), next);

  assert.ok(calls[0][0] instanceof AppError);
  assert.strictEqual(calls[0][0].statusCode, 404);
});

test('postPortfolio — newly added organisation: 201, created: true', async () => {
  const item = { id: 'p1', customer_id: 'c1', organisation_id: VALID_ORG_ID, added_by_user_id: 'u1' };
  const postPortfolio = createPostPortfolio(async (customerId, organisationId, userId) => {
    assert.strictEqual(customerId, 'c1');
    assert.strictEqual(organisationId, VALID_ORG_ID);
    assert.strictEqual(userId, 'u1');
    return { success: true, item, created: true };
  }, reverseFound);
  const req = tenantReq({ body: { organisationId: VALID_ORG_ID } });
  const res = fakeRes();

  await postPortfolio(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.statusCode, 201);
  assert.deepStrictEqual(res.body, { success: true, created: true, item });
});

test('postPortfolio — organisation already in the portfolio: 200, created: false', async () => {
  const item = { id: 'p1', organisation_id: VALID_ORG_ID };
  const postPortfolio = createPostPortfolio(async () => ({ success: true, item, created: false }), reverseFound);
  const req = tenantReq({ body: { organisationId: VALID_ORG_ID } });
  const res = fakeRes();

  await postPortfolio(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.created, false);
});

test('postPortfolio — a DB failure surfaces as an AppError to next()', async () => {
  const postPortfolio = createPostPortfolio(async () => ({ success: false, error: 'insert failed' }), reverseFound);
  const req = tenantReq({ body: { organisationId: VALID_ORG_ID } });
  const { next, calls } = fakeNext();

  await postPortfolio(req, fakeRes(), next);

  assert.ok(calls[0][0] instanceof AppError);
  assert.strictEqual(calls[0][0].message, 'insert failed');
});

// ── DELETE /api/portfolio/:organisationId ────────────────────────────────────

test('deletePortfolio — 404 when the organisation is not in the portfolio', async () => {
  const deletePortfolio = createDeletePortfolio(
    async () => null,
    async () => assert.fail('remove should not be called when nothing was found')
  );
  const req = tenantReq({ params: { organisationId: 'o-not-tracked' } });
  const res = fakeRes();

  await deletePortfolio(req, res, () => assert.fail('next() should not be called'));

  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(res.body, { success: false, error: 'Portfolio item not found' });
});

test('deletePortfolio — removes an existing item: 200 { success: true }', async () => {
  const deletePortfolio = createDeletePortfolio(
    async (customerId, organisationId) => ({ id: 'p1', organisation_id: organisationId }),
    async (customerId, organisationId) => {
      assert.strictEqual(customerId, 'c1');
      assert.strictEqual(organisationId, 'o1');
      return { success: true };
    }
  );
  const req = tenantReq({ params: { organisationId: 'o1' } });
  const res = fakeRes();

  await deletePortfolio(req, res, () => assert.fail('next() should not be called'));

  assert.deepStrictEqual(res.body, { success: true });
});

test('deletePortfolio — a DB failure on removal surfaces as an AppError to next()', async () => {
  const deletePortfolio = createDeletePortfolio(
    async () => ({ id: 'p1' }),
    async () => ({ success: false, error: 'delete failed' })
  );
  const req = tenantReq({ params: { organisationId: 'o1' } });
  const { next, calls } = fakeNext();

  await deletePortfolio(req, fakeRes(), next);

  assert.ok(calls[0][0] instanceof AppError);
});
