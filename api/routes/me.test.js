'use strict';

// me.test.js — tests the GET /api/me handler in isolation (no HTTP server,
// no supertest dependency; matches this codebase's DI + fake req/res style).
// requireAuth/attachTenant are covered by their own middleware tests — this
// file assumes they already ran and populated req.user/req.tenant.

const { test } = require('node:test');
const assert = require('node:assert');

const { getMe } = require('./me');

function fakeRes() {
  const res = { body: null };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('GET /api/me — operations user: role present, customer/membership null', () => {
  const req = { user: { id: 'u1', email: 'ops@soterius.com', role: 'operations' }, tenant: null };
  const res = fakeRes();

  getMe(req, res, () => assert.fail('next() should not be called'));

  assert.deepStrictEqual(res.body, {
    user:       { id: 'u1', email: 'ops@soterius.com' },
    role:       'operations',
    customer:   null,
    membership: null,
  });
});

test('GET /api/me — customer user with a tenant: customer + membership populated', () => {
  const req = {
    user:   { id: 'u1', email: 'jane@smithllp.co.uk', role: 'customer' },
    tenant: { id: 'm1', tenantRole: 'owner', customer: { id: 'c1', name: 'Smith LLP', plan: 'trial' } },
  };
  const res = fakeRes();

  getMe(req, res, () => assert.fail('next() should not be called'));

  assert.deepStrictEqual(res.body, {
    user:       { id: 'u1', email: 'jane@smithllp.co.uk' },
    role:       'customer',
    customer:   { id: 'c1', name: 'Smith LLP', plan: 'trial' },
    membership: { tenantRole: 'owner' },
  });
});

test('GET /api/me — customer user with no tenant yet: valid pre-onboarding state, not an error', () => {
  const req = { user: { id: 'u-new', email: 'new@firm.co.uk', role: 'customer' }, tenant: null };
  const res = fakeRes();

  getMe(req, res, () => assert.fail('next() should not be called'));

  assert.deepStrictEqual(res.body, {
    user:       { id: 'u-new', email: 'new@firm.co.uk' },
    role:       'customer',
    customer:   null,
    membership: null,
  });
});
