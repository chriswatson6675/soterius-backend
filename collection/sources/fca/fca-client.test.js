'use strict';

// fca-client.test.js — Phase 1 transport + config regression tests (IMP-FCA-001 §1).
//
// Focus, per the Phase 1 acceptance criteria:
//   - a live-shaped success returns parsed data AND the FSR envelope;
//   - an FCA "empty" response (HTTP 200 + FSR-API-…-11 + Data:null) is NOT a
//     transport failure [CR-FCA-05];
//   - malformed bodies retain the raw bytes [CR-FCA-03];
//   - the credential is never present in any returned structure [CR-FCA-07];
//   - config validation rejects missing credentials before any request.

const { test } = require('node:test');
const assert = require('node:assert');

const client = require('./fca-client');

const BASE = client.DEFAULT_BASE_URL;

/** Injectable transport: scripts a response by URL prefix and records headers seen. */
function scriptedFetch(routes) {
  const seen = [];
  const fetchFn = async (url, o) => {
    seen.push({ url, headers: { ...(o.headers || {}) } });
    const route = routes.find((r) => url.startsWith(r.prefix));
    if (!route) return { statusCode: 404, headers: {}, bodyBuffer: Buffer.from('') };
    if (route.error) return { error: route.error };
    const res = route.respond(url);
    return {
      statusCode: res.statusCode,
      headers: res.headers || {},
      bodyBuffer: res.bodyBuffer || Buffer.from(res.body || ''),
    };
  };
  return { fetchFn, seen };
}

test('success: returns parsed Data AND the FCA envelope', async () => {
  const payload = {
    Status: 'FSR-API-02-01-00',
    ResultInfo: { page: '1', per_page: '1', total_count: '1' },
    Message: 'Ok. Firm Found',
    Data: [{ FRN: '122702', 'Organisation Name': 'Barclays Bank Plc' }],
  };
  const { fetchFn } = scriptedFetch([
    { prefix: `${BASE}/Firm/`, respond: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) },
  ]);

  const res = await client.getJson(`${BASE}/Firm/122702`, { email: 'e@x', apiKey: 'k', _fetch: fetchFn });

  assert.strictEqual(res.errorType, 'NONE');
  assert.strictEqual(res.httpStatus, 200);
  assert.strictEqual(res.fsrStatus, 'FSR-API-02-01-00');
  assert.strictEqual(res.envelope.message, 'Ok. Firm Found');
  assert.strictEqual(res.body.Data[0]['Organisation Name'], 'Barclays Bank Plc');
});

test('observed-absence: HTTP 200 + FSR-…-11 + Data:null is NOT a transport failure', async () => {
  const payload = { Status: 'FSR-API-02-13-11', Message: 'Investment Types not found', ResultInfo: null, Data: null };
  const { fetchFn } = scriptedFetch([
    { prefix: `${BASE}/Firm/`, respond: () => ({ statusCode: 200, headers: {}, body: JSON.stringify(payload) }) },
  ]);

  const res = await client.getJson(`${BASE}/Firm/122702/Requirements/OR-1/InvestmentTypes`, { email: 'e@x', apiKey: 'k', _fetch: fetchFn });

  // Transport is fine (NONE); the FSR code is surfaced separately, uninterpreted [CR-FCA-05].
  assert.strictEqual(res.errorType, 'NONE');
  assert.strictEqual(res.httpStatus, 200);
  assert.strictEqual(res.fsrStatus, 'FSR-API-02-13-11');
  assert.strictEqual(res.body.Data, null);
});

test('malformed JSON: PARSE_ERROR but raw body retained verbatim [CR-FCA-03]', async () => {
  const { fetchFn } = scriptedFetch([
    { prefix: `${BASE}/Firm/`, respond: () => ({ statusCode: 200, headers: {}, body: 'this is <not> json' }) },
  ]);

  const res = await client.getJson(`${BASE}/Firm/122702`, { email: 'e@x', apiKey: 'k', _fetch: fetchFn });

  assert.strictEqual(res.errorType, 'PARSE_ERROR');
  assert.strictEqual(res.body, null);
  assert.strictEqual(res.rawBody, 'this is <not> json');
  assert.ok(res.errorMessage, 'a parse error message is surfaced');
});

test('auth headers are sent on the request', async () => {
  const { fetchFn, seen } = scriptedFetch([
    { prefix: `${BASE}/Firm/`, respond: () => ({ statusCode: 200, headers: {}, body: '{"Status":"FSR-API-02-01-00","Data":[]}' }) },
  ]);

  await client.getJson(`${BASE}/Firm/122702`, { email: 'observer@example.com', apiKey: 'SECRET_KEY', _fetch: fetchFn });

  assert.strictEqual(seen[0].headers['X-Auth-Email'], 'observer@example.com');
  assert.strictEqual(seen[0].headers['X-Auth-Key'], 'SECRET_KEY');
  assert.strictEqual(seen[0].headers['Accept'], 'application/json');
});

test('credential is never present in the returned result [CR-FCA-07]', async () => {
  const { fetchFn } = scriptedFetch([
    { prefix: `${BASE}/Firm/`, respond: () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"Status":"FSR-API-02-01-00","Data":[]}' }) },
  ]);

  const res = await client.getJson(`${BASE}/Firm/122702`, { email: 'observer@example.com', apiKey: 'SECRET_KEY', _fetch: fetchFn });

  const serialised = JSON.stringify(res);
  assert.ok(!serialised.includes('SECRET_KEY'), 'API key must not appear in the result');
  assert.ok(!serialised.includes('observer@example.com'), 'email must not appear in the result');
});

test('connection error: classified as CONNECTION_ERROR, never thrown', async () => {
  const { fetchFn } = scriptedFetch([
    { prefix: `${BASE}/Firm/`, error: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }) },
  ]);

  const res = await client.getJson(`${BASE}/Firm/122702`, { email: 'e@x', apiKey: 'k', _fetch: fetchFn });

  assert.strictEqual(res.errorType, 'CONNECTION_ERROR');
  assert.strictEqual(res.httpStatus, null);
  assert.strictEqual(res.errorMessage, 'ENOTFOUND');
});

test('rate-limited: HTTP 429 surfaced as RATE_LIMITED with body retained', async () => {
  const { fetchFn } = scriptedFetch([
    { prefix: `${BASE}/Firm/`, respond: () => ({ statusCode: 429, headers: { 'retry-after': '30' }, body: 'slow down' }) },
  ]);

  const res = await client.getJson(`${BASE}/Firm/122702`, { email: 'e@x', apiKey: 'k', _fetch: fetchFn });

  assert.strictEqual(res.errorType, 'RATE_LIMITED');
  assert.strictEqual(res.httpStatus, 429);
  assert.strictEqual(res.rawBody, 'slow down');
});

test('validateConfig: rejects missing credentials, accepts a complete config', () => {
  const missing = client.validateConfig({ email: null, apiKey: null, baseUrl: client.DEFAULT_BASE_URL });
  assert.strictEqual(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes('FCA_EMAIL')));
  assert.ok(missing.errors.some((e) => e.includes('FCA_API_KEY')));

  const bad = client.validateConfig({ email: 'e', apiKey: 'k', baseUrl: 'not a url' });
  assert.strictEqual(bad.ok, false);

  const ok = client.validateConfig({ email: 'e', apiKey: 'k', baseUrl: client.DEFAULT_BASE_URL });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.errors, []);
});

test('loadConfig: reads FCA_EMAIL / FCA_API_KEY from the environment', () => {
  const cfg = client.loadConfig({ FCA_EMAIL: 'a@b', FCA_API_KEY: 'kk' });
  assert.strictEqual(cfg.email, 'a@b');
  assert.strictEqual(cfg.apiKey, 'kk');
  assert.strictEqual(cfg.baseUrl, client.DEFAULT_BASE_URL);
  assert.strictEqual(cfg.apiVersion, 'V0.1');
});

test('buildUrl: joins base and path without doubling slashes', () => {
  assert.strictEqual(client.buildUrl(BASE, '/Firm/122702'), `${BASE}/Firm/122702`);
  assert.strictEqual(client.buildUrl(BASE + '/', 'Firm/122702'), `${BASE}/Firm/122702`);
});
