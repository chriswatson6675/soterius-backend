'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createRequireAuth, parseBearerToken } = require('./requireAuth');

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

test('parseBearerToken — extracts the token from a well-formed header', () => {
  assert.strictEqual(parseBearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
});

test('parseBearerToken — returns null for a missing or malformed header', () => {
  assert.strictEqual(parseBearerToken(undefined), null);
  assert.strictEqual(parseBearerToken(''), null);
  assert.strictEqual(parseBearerToken('abc.def.ghi'), null); // no scheme
  assert.strictEqual(parseBearerToken('Basic abc.def.ghi'), null); // wrong scheme
});

test('requireAuth — 401 when Authorization header is absent, does not call getUserFromToken', async () => {
  let called = false;
  const requireAuth = createRequireAuth(async () => { called = true; return { id: 'u1' }; });
  const req = { headers: {} };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await requireAuth(req, res, next);

  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(res.body, { success: false, error: 'Unauthorized' });
  assert.strictEqual(called, false);
  assert.strictEqual(calls.length, 0);
});

test('requireAuth — 401 when the token fails validation (expired/invalid/forged)', async () => {
  const requireAuth = createRequireAuth(async () => null);
  const req = { headers: { authorization: 'Bearer bad-token' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await requireAuth(req, res, next);

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(calls.length, 0);
});

test('requireAuth — attaches req.user and calls next() on a valid token', async () => {
  const user = { id: 'u1', email: 'jane@smithllp.co.uk', role: 'customer' };
  const requireAuth = createRequireAuth(async (token) => (token === 'good-token' ? user : null));
  const req = { headers: { authorization: 'Bearer good-token' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await requireAuth(req, res, next);

  assert.strictEqual(res.statusCode, null); // never responded
  assert.deepStrictEqual(req.user, user);
  assert.strictEqual(calls.length, 1);
});

test('requireAuth — 401 (not a crash) if the token-verification dependency throws', async () => {
  const requireAuth = createRequireAuth(async () => { throw new Error('network error'); });
  const req = { headers: { authorization: 'Bearer good-token' } };
  const res = fakeRes();
  const { next, calls } = fakeNext();

  await requireAuth(req, res, next);

  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(calls.length, 0);
});
