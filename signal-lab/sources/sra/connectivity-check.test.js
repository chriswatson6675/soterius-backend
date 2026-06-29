'use strict';

// connectivity-check.test.js — Observe-layer connectivity probe tests.
//
// Covers the happy path (auth + reachable + valid shape), authentication failure,
// endpoint inaccessibility, invalid response shape, and invalid configuration.

const { test } = require('node:test');
const assert = require('node:assert');

const { checkConnectivity } = require('./connectivity-check');
const { defineSource } = require('./snapshot-source');

// Test fixtures use a "firms"/"productionDate" shape; bind a matching source so the
// tests are independent of the production (SRA-confirmed) default locators.
const FIXTURE_SOURCE = defineSource({ recordsPath: ['firms'], productionTimestampPath: ['productionDate'] });

function bodyBuf(s) { return Buffer.from(typeof s === 'string' ? s : JSON.stringify(s), 'utf8'); }
function resp(body, status = 200) { return { statusCode: status, headers: {}, bodyBuffer: bodyBuf(body) }; }
function constFetch(r, calls = []) { return async (url, o) => { calls.push({ url, headers: o.headers }); return typeof r === 'function' ? r(url, o) : r; }; }

const CONFIG = { baseUrl: 'https://x', subscriptionKey: 'KEY' };

test('ok: 200 + records array → all checks pass; reports count + timestamp', async () => {
  const RAW = JSON.stringify({ productionDate: '2026-06-28', firms: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  const calls = [];
  const r = await checkConnectivity({ config: CONFIG, source: FIXTURE_SOURCE, _fetch: constFetch(resp(RAW), calls) });

  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.checks, { configValid: true, authentication: true, endpointAccessible: true, shapeValid: true });
  assert.strictEqual(r.recordCountSeen, 3);
  assert.strictEqual(r.productionTimestamp, '2026-06-28');
  assert.strictEqual(r.httpStatus, 200);
  // the key is sent on the probe request
  assert.strictEqual(calls[0].headers['Ocp-Apim-Subscription-Key'], 'KEY');
});

test('authentication failure: 401 → authentication false, not ok', async () => {
  const r = await checkConnectivity({ config: CONFIG, _fetch: constFetch(resp('denied', 401)) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.checks.authentication, false);
  assert.strictEqual(r.httpStatus, 401);
});

test('endpoint inaccessible: connection error → endpointAccessible false', async () => {
  const r = await checkConnectivity({ config: CONFIG, _fetch: constFetch({ error: { code: 'ENOTFOUND' } }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.checks.endpointAccessible, false);
  assert.strictEqual(r.checks.authentication, false);
  assert.strictEqual(r.errorType, 'CONNECTION_ERROR');
});

test('endpoint 404 → endpointAccessible false (authenticated, but wrong path)', async () => {
  const r = await checkConnectivity({ config: CONFIG, _fetch: constFetch(resp('nope', 404)) });
  assert.strictEqual(r.checks.authentication, true);
  assert.strictEqual(r.checks.endpointAccessible, false);
  assert.strictEqual(r.ok, false);
});

test('invalid shape: 200 but no records array → shapeValid false', async () => {
  const r = await checkConnectivity({ config: CONFIG, _fetch: constFetch(resp('{"somethingElse":true}')) });
  assert.strictEqual(r.checks.authentication, true);
  assert.strictEqual(r.checks.endpointAccessible, true);
  assert.strictEqual(r.checks.shapeValid, false);
  assert.strictEqual(r.ok, false);
  assert.match(r.detail, /records not found/);
});

test('invalid shape: 200 but body is not JSON → shapeValid false', async () => {
  const r = await checkConnectivity({ config: CONFIG, _fetch: constFetch(resp('<<html>>')) });
  assert.strictEqual(r.checks.shapeValid, false);
  assert.match(r.detail, /not valid JSON/);
});

test('invalid configuration short-circuits before any request', async () => {
  let called = false;
  const r = await checkConnectivity({ config: { baseUrl: 'https://x' }, _fetch: async () => { called = true; return resp('{}'); } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.checks.configValid, false);
  assert.strictEqual(called, false, 'no request is made when config is invalid');
  assert.match(r.detail, /SRA_SUBSCRIPTION_KEY/);
});
