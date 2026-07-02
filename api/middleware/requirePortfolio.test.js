'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createRequirePortfolio } = require('./requirePortfolio');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function fakeNext() {
  const calls = [];
  const next = (...args) => calls.push(args);
  return { next, calls };
}

const disabled = () => false;
const enabled  = () => true;

test('flag disabled — always next(), no DB call, regardless of role/tenant/portfolio state', async () => {
  let dbCalled = false;
  const requirePortfolio = createRequirePortfolio('id', async () => { dbCalled = true; return null; }, disabled);
  const req = { user: { role: 'customer' }, tenant: null, params: { id: 'o1' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await requirePortfolio(req, res, next);

  assert.strictEqual(res.statusCode, null);
  assert.strictEqual(dbCalled, false);
  assert.strictEqual(calls.length, 1);
});

test('flag enabled — operations role bypasses entirely, no DB call (ADR-SYS-007 §3.4)', async () => {
  let dbCalled = false;
  const requirePortfolio = createRequirePortfolio('id', async () => { dbCalled = true; return null; }, enabled);
  const req = { user: { role: 'operations' }, tenant: null, params: { id: 'o1' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await requirePortfolio(req, res, next);

  assert.strictEqual(res.statusCode, null);
  assert.strictEqual(dbCalled, false);
  assert.strictEqual(calls.length, 1);
});

test('flag enabled — customer with no tenant: 403, no DB call', async () => {
  let dbCalled = false;
  const requirePortfolio = createRequirePortfolio('id', async () => { dbCalled = true; return null; }, enabled);
  const req = { user: { role: 'customer' }, tenant: null, params: { id: 'o1' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await requirePortfolio(req, res, next);

  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(res.body, { success: false, error: 'Forbidden' });
  assert.strictEqual(dbCalled, false);
  assert.strictEqual(calls.length, 0);
});

test('flag enabled — customer whose organisation is not in the portfolio: 403', async () => {
  const requirePortfolio = createRequirePortfolio('id', async () => null, enabled);
  const req = { user: { role: 'customer' }, tenant: { customer: { id: 'c1' } }, params: { id: 'o-not-tracked' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await requirePortfolio(req, res, next);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(calls.length, 0);
});

test('flag enabled — 403 is identical whether the org is missing from the portfolio or does not exist at all (no existence oracle)', async () => {
  const requirePortfolio = createRequirePortfolio('id', async () => null, enabled);
  const reqA = { user: { role: 'customer' }, tenant: { customer: { id: 'c1' } }, params: { id: 'real-org-not-mine' } };
  const reqB = { user: { role: 'customer' }, tenant: { customer: { id: 'c1' } }, params: { id: 'does-not-exist' } };
  const resA = fakeRes();
  const resB = fakeRes();

  await requirePortfolio(reqA, resA, () => {});
  await requirePortfolio(reqB, resB, () => {});

  assert.deepStrictEqual(resA.body, resB.body);
  assert.strictEqual(resA.statusCode, resB.statusCode);
});

test('flag enabled — customer whose organisation IS in the portfolio: attaches req.portfolioItem, calls next()', async () => {
  const item = { id: 'p1', organisation_id: 'o1', is_home: true };
  const requirePortfolio = createRequirePortfolio(
    'id',
    async (customerId, organisationId) => (customerId === 'c1' && organisationId === 'o1' ? item : null),
    enabled
  );
  const req = { user: { role: 'customer' }, tenant: { customer: { id: 'c1' } }, params: { id: 'o1' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await requirePortfolio(req, res, next);

  assert.strictEqual(res.statusCode, null);
  assert.deepStrictEqual(req.portfolioItem, item);
  assert.strictEqual(calls.length, 1);
});

test('flag enabled — uses the configured route param name', async () => {
  let capturedOrgId;
  const requirePortfolio = createRequirePortfolio(
    'organisationId',
    async (customerId, organisationId) => { capturedOrgId = organisationId; return { id: 'p1' }; },
    enabled
  );
  const req = { user: { role: 'customer' }, tenant: { customer: { id: 'c1' } }, params: { organisationId: 'o42' } };

  await requirePortfolio(req, fakeRes(), () => {});

  assert.strictEqual(capturedOrgId, 'o42');
});

test('flag enabled — errors from the DB dependency go to next(err), not a crash', async () => {
  const boom = new Error('db unreachable');
  const requirePortfolio = createRequirePortfolio('id', async () => { throw boom; }, enabled);
  const req = { user: { role: 'customer' }, tenant: { customer: { id: 'c1' } }, params: { id: 'o1' } };
  const { next, calls } = fakeNext();

  await requirePortfolio(req, fakeRes(), next);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], boom);
});
