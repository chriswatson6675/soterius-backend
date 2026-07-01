'use strict';

// resolve-anchor.test.js — Phase 3 anchor resolution tests (IMP-FCA-001 §3).

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAnchor, RESOLUTION } = require('./resolve-anchor');

const CONFIG = { baseUrl: 'https://register.fca.org.uk/services/V0.1', email: 'e@x', apiKey: 'k' };

/** Injectable transport returning a scripted /Search body. */
function searchFetch(dataArray) {
  return async (_url, _o) => ({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    bodyBuffer: Buffer.from(JSON.stringify({ Status: 'FSR-API-04-01-00', ResultInfo: {}, Message: 'ok', Data: dataArray })),
  });
}

test('direct FRN: resolves without searching', async () => {
  const r = await resolveAnchor('122702', { config: CONFIG, _fetch: () => { throw new Error('should not fetch'); } });
  assert.strictEqual(r.resolution, RESOLUTION.DIRECT);
  assert.strictEqual(r.anchor, '122702');
  assert.strictEqual(r.ok, true);
});

test('name → single result resolves', async () => {
  const r = await resolveAnchor('Some Unique Firm Ltd', {
    config: CONFIG,
    _fetch: searchFetch([{ Name: 'Some Unique Firm Ltd', 'Reference Number': '999001', Status: 'Authorised' }]),
  });
  assert.strictEqual(r.resolution, RESOLUTION.RESOLVED);
  assert.strictEqual(r.anchor, '999001');
  assert.strictEqual(r.method, 'search-single');
});

test('name → multiple results, no exact match → AMBIGUOUS (no guess)', async () => {
  const r = await resolveAnchor('Barclays', {
    config: CONFIG,
    _fetch: searchFetch([
      { Name: 'Barclays Bank Plc', 'Reference Number': '122702', Status: 'x' },
      { Name: 'Barclays Investment Solutions Limited', 'Reference Number': '155595', Status: 'x' },
    ]),
  });
  assert.strictEqual(r.resolution, RESOLUTION.AMBIGUOUS);
  assert.strictEqual(r.anchor, null);
  assert.strictEqual(r.candidateCount, 2);
  assert.strictEqual(r.candidates.length, 2);
});

test('name → multiple results but one EXACT normalised-name match resolves', async () => {
  const r = await resolveAnchor('Barclays Bank Plc', {
    config: CONFIG,
    _fetch: searchFetch([
      { Name: 'Barclays Bank Plc (Postcode: E14 5HP)', 'Reference Number': '122702', Status: 'x' },
      { Name: 'Barclays Bank UK PLC', 'Reference Number': '759676', Status: 'x' },
    ]),
  });
  assert.strictEqual(r.resolution, RESOLUTION.RESOLVED);
  assert.strictEqual(r.anchor, '122702');
  assert.strictEqual(r.method, 'search-exact-name');
});

test('name → zero results → NOT_FOUND', async () => {
  const r = await resolveAnchor('No Such Firm Whatsoever XYZ', { config: CONFIG, _fetch: searchFetch([]) });
  assert.strictEqual(r.resolution, RESOLUTION.NOT_FOUND);
  assert.strictEqual(r.anchor, null);
});

test('clone result is recorded as a warning and never resolved to', async () => {
  const r = await resolveAnchor('Cloney Capital', {
    config: CONFIG,
    _fetch: searchFetch([{ Name: 'Cloney Capital (clone of an FCA authorised Firm)', 'Reference Number': '' }]),
  });
  // the only "hit" is a clone with no FRN → not a candidate
  assert.strictEqual(r.resolution, RESOLUTION.NOT_FOUND);
  assert.strictEqual(r.cloneWarnings.length, 1);
});

test('transport failure → ERROR (non-observation), not a guess', async () => {
  const r = await resolveAnchor('Whoever Ltd', {
    config: CONFIG,
    _fetch: async () => ({ error: Object.assign(new Error('dns'), { code: 'ENOTFOUND' }) }),
  });
  assert.strictEqual(r.resolution, RESOLUTION.ERROR);
  assert.strictEqual(r.ok, false);
});

test('empty input → NOT_FOUND', async () => {
  const r = await resolveAnchor('   ', { config: CONFIG, _fetch: () => { throw new Error('no fetch'); } });
  assert.strictEqual(r.resolution, RESOLUTION.NOT_FOUND);
});
