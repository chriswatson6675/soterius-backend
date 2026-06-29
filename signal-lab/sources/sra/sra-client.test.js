'use strict';

// sra-client.test.js — transport-only client tests.
//
// Covers configuration load/validation, subscription-key authentication (sent in
// the request, NEVER returned), byte-faithful raw body, and transport-failure
// classification (success / rate-limited / HTTP error / connection error).

const { test } = require('node:test');
const assert = require('node:assert');
const client = require('./sra-client');

function bodyBuf(s) { return Buffer.from(typeof s === 'string' ? s : JSON.stringify(s), 'utf8'); }
function okResp(body, status = 200, headers = {}) { return { statusCode: status, headers, bodyBuffer: bodyBuf(body) }; }
function errResp(code) { return { error: { code } }; }

test('loadConfig reads SRA_SUBSCRIPTION_KEY and SRA_BASE_URL from env', () => {
  const c = client.loadConfig({ SRA_SUBSCRIPTION_KEY: 'K', SRA_BASE_URL: 'https://gw.example/api' });
  assert.strictEqual(c.subscriptionKey, 'K');
  assert.strictEqual(c.baseUrl, 'https://gw.example/api');
});

test('loadConfig falls back to the default base URL', () => {
  const c = client.loadConfig({ SRA_SUBSCRIPTION_KEY: 'K' });
  assert.strictEqual(c.baseUrl, client.DEFAULT_BASE_URL);
  assert.strictEqual(client.loadConfig({}).subscriptionKey, null);
});

test('validateConfig requires a subscription key and a valid base URL', () => {
  assert.deepStrictEqual(client.validateConfig({ subscriptionKey: 'K', baseUrl: 'https://x' }), { ok: true, errors: [] });
  assert.ok(client.validateConfig({ baseUrl: 'https://x' }).errors.some((e) => /SRA_SUBSCRIPTION_KEY/.test(e)));
  assert.ok(client.validateConfig({ subscriptionKey: 'K', baseUrl: 'not a url' }).errors.some((e) => /valid URL/.test(e)));
  assert.deepStrictEqual(client.validateConfig(null), { ok: false, errors: ['configuration object missing'] });
});

test('buildUrl joins base + path tolerantly', () => {
  assert.strictEqual(client.buildUrl('https://x/', 'firms'), 'https://x/firms');
  assert.strictEqual(client.buildUrl('https://x', '/firms'), 'https://x/firms');
});

test('get: 2xx → NONE, preserves the raw body, sends the key, NEVER returns it', async () => {
  const calls = [];
  const _fetch = async (url, o) => { calls.push({ url, headers: o.headers }); return okResp('{"firms":[],"productionDate":"2026-06-28"}'); };
  const res = await client.get('https://x/firms', { subscriptionKey: 'SECRET-KEY', _fetch });

  assert.strictEqual(res.errorType, 'NONE');
  assert.strictEqual(res.httpStatus, 200);
  assert.strictEqual(res.rawBody, '{"firms":[],"productionDate":"2026-06-28"}');
  assert.strictEqual(calls[0].headers[client.SUBSCRIPTION_KEY_HEADER], 'SECRET-KEY', 'key is sent on the request');
  assert.ok(!JSON.stringify(res).includes('SECRET-KEY'), 'key NEVER appears in the result');
});

test('get classifies transport failures', async () => {
  const r429 = await client.get('https://x', { subscriptionKey: 'K', _fetch: async () => okResp('rate', 429) });
  assert.strictEqual(r429.errorType, 'RATE_LIMITED');
  assert.strictEqual(r429.httpStatus, 429);

  const r500 = await client.get('https://x', { subscriptionKey: 'K', _fetch: async () => okResp('boom', 500) });
  assert.strictEqual(r500.errorType, 'HTTP_ERROR');
  assert.strictEqual(r500.httpStatus, 500);

  const r401 = await client.get('https://x', { subscriptionKey: 'BAD', _fetch: async () => okResp('denied', 401) });
  assert.strictEqual(r401.errorType, 'HTTP_ERROR');
  assert.strictEqual(r401.httpStatus, 401, 'auth rejection surfaces as an HTTP error with the status');

  const rconn = await client.get('https://x', { subscriptionKey: 'K', _fetch: async () => errResp('ECONNREFUSED') });
  assert.strictEqual(rconn.errorType, 'CONNECTION_ERROR');
  assert.strictEqual(rconn.httpStatus, null);

  const rbad = await client.get('https://x', { subscriptionKey: 'K', _fetch: async () => errResp('SOMETHING_ELSE') });
  assert.strictEqual(rbad.errorType, 'CONNECTION_ERROR', 'unknown error codes still classify as a connection failure');
});

test('get retains the raw body even on an HTTP error', async () => {
  const res = await client.get('https://x', { subscriptionKey: 'K', _fetch: async () => okResp('error detail', 500) });
  assert.strictEqual(res.rawBody, 'error detail');
});
