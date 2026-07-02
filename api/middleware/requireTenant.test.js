'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { requireTenant } = require('./requireTenant');

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

test('requireTenant — 403 when req.tenant is null (unonboarded customer)', () => {
  const req = { tenant: null };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  requireTenant(req, res, next);

  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(res.body, { success: false, error: 'No tenant for this account' });
  assert.strictEqual(calls.length, 0);
});

test('requireTenant — 403 for an operations caller (never tenant-scoped, ADR-SYS-007 §3.4)', () => {
  // attachTenant always sets req.tenant = null for operations — same 403 as any other tenant-less caller.
  const req = { user: { role: 'operations' }, tenant: null };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  requireTenant(req, res, next);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(calls.length, 0);
});

test('requireTenant — calls next() when req.tenant is present', () => {
  const req = { tenant: { id: 'm1', tenantRole: 'owner', customer: { id: 'c1' } } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  requireTenant(req, res, next);

  assert.strictEqual(res.statusCode, null);
  assert.strictEqual(calls.length, 1);
});
