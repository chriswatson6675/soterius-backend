'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createAttachTenant } = require('./attachTenant');

function fakeNext() {
  const calls = [];
  const next = (...args) => calls.push(args);
  return { next, calls };
}

test('attachTenant — operations role skips tenant resolution entirely (ADR-SYS-007 §3.4)', async () => {
  let membershipLookupCalled = false;
  const attachTenant = createAttachTenant(async () => { membershipLookupCalled = true; return null; });
  const req = { user: { id: 'u1', role: 'operations' } };
  const { next, calls } = fakeNext();

  await attachTenant(req, {}, next);

  assert.strictEqual(req.tenant, null);
  assert.strictEqual(membershipLookupCalled, false);
  assert.strictEqual(calls.length, 1);
});

test('attachTenant — customer role with a membership attaches req.tenant', async () => {
  const membership = { id: 'm1', tenantRole: 'owner', customer: { id: 'c1', name: 'Smith LLP' } };
  const attachTenant = createAttachTenant(async (userId) => (userId === 'u1' ? membership : null));
  const req = { user: { id: 'u1', role: 'customer' } };
  const { next, calls } = fakeNext();

  await attachTenant(req, {}, next);

  assert.deepStrictEqual(req.tenant, membership);
  assert.strictEqual(calls.length, 1);
});

test('attachTenant — customer role with no membership yet is valid, not an error (pre-onboarding)', async () => {
  const attachTenant = createAttachTenant(async () => null);
  const req = { user: { id: 'u-new', role: 'customer' } };
  const { next, calls } = fakeNext();

  await attachTenant(req, {}, next);

  assert.strictEqual(req.tenant, null);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], []); // next() called with no error
});

test('attachTenant — defensive: missing req.user (out-of-order middleware) does not throw', async () => {
  const attachTenant = createAttachTenant(async () => { throw new Error('should not be called'); });
  const req = {};
  const { next, calls } = fakeNext();

  await attachTenant(req, {}, next);

  assert.strictEqual(req.tenant, null);
  assert.strictEqual(calls.length, 1);
});

test('attachTenant — passes errors to next(err) rather than crashing', async () => {
  const boom = new Error('db unreachable');
  const attachTenant = createAttachTenant(async () => { throw boom; });
  const req = { user: { id: 'u1', role: 'customer' } };
  const { next, calls } = fakeNext();

  await attachTenant(req, {}, next);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], boom);
});
