'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHealthReadyHandler } = require('./health-ready-handler');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

describe('createHealthReadyHandler', () => {
  test('200 + reachable when the database query succeeds', async () => {
    const client = { from: () => ({ select: () => ({ limit: async () => ({ data: [{ version: '1' }], error: null }) }) }) };
    const handler = createHealthReadyHandler({ getClient: () => client });
    const res = fakeRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.database, 'reachable');
  });

  test('503 + unreachable when the database query returns an error', async () => {
    const client = { from: () => ({ select: () => ({ limit: async () => ({ data: null, error: { message: 'connection refused' } }) }) }) };
    const handler = createHealthReadyHandler({ getClient: () => client });
    const res = fakeRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.database, 'unreachable');
    assert.match(res.body.error, /connection refused/);
  });

  test('503 + unreachable when getClient() itself throws (e.g. missing env vars)', async () => {
    const handler = createHealthReadyHandler({ getClient: () => { throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required'); } });
    const res = fakeRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    assert.match(res.body.error, /SUPABASE_URL/);
  });

  test('503 + unreachable when the database query hangs past the configured timeout', async () => {
    const client = { from: () => ({ select: () => ({ limit: () => new Promise(() => {}) }) }) }; // never resolves
    const handler = createHealthReadyHandler({ getClient: () => client, timeoutMs: 20 });
    const res = fakeRes();
    await handler({}, res);
    assert.strictEqual(res.statusCode, 503);
    assert.match(res.body.error, /timed out/);
  });
});
