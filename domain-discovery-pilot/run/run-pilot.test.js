'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runPilot, CAPS } = require('./run-pilot');
const { createFakeClient } = require('../persistence/fake-client');

function buildRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      rowIndex: i,
      registrationNumber: String(200000 + i),
      businessName: `Test Firm ${i} Limited`,
      tradingName: null,
      postcode: 'SW1A 1AA',
      status: 'Active',
    });
  }
  return rows;
}

function fakeAdapter(rows) {
  return {
    async parse() { return rows; },
    validateStructure(rs) { return { valid: rs, rejected: [] }; },
    normalise(validRows) { return validRows.map((r) => ({ name: r.businessName, tradingName: r.tradingName, hmrcAml: r.registrationNumber })); },
  };
}

function fakeResolveNoMatch() {
  return { search: () => ({ ok: true, results: [] }) };
}

function fakeHttpGet(domainSuffix) {
  let n = 0;
  return async () => {
    n += 1;
    return {
      status: 200,
      headers: {},
      data: { web: { results: [{ url: `https://firm${n}.${domainSuffix}/`, title: 'Firm', description: 'd' }] } },
    };
  };
}

function fakeFetchUrl() {
  return async (url) => ({
    success: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html',
    body: '<html><head><title>Test Firm Limited</title></head><body>Test Firm Limited, SW1A 1AA</body></html>',
    retrievedAt: '2026-07-15T00:00:00.000Z',
  });
}

test('runPilot: offline end-to-end run over a small synthetic pool persists candidates, prefilter, and decisions', async () => {
  const client = createFakeClient();
  const rows = buildRows(5);
  const result = await runPilot({
    odsPath: __filename, // any existing file — fakeAdapter never reads its bytes
    hmrcAdapter: fakeAdapter(rows),
    client,
    throttleMs: 0,
  });

  assert.equal(result.sampleMeta.sampleSize, 5);
  assert.equal(result.bundle.candidates.length, 5);
  assert.equal(result.bundle.prefilterResults.length, 5);
  assert.equal(result.bundle.decisions.length, 5);
  assert.equal(client._tables.domain_discovery_pilot_candidates.length, 5);
});

test('runPilot: NO_MATCH prefilter always leads to a Brave search attempt (never SKIPPED)', async () => {
  const client = createFakeClient();
  const rows = buildRows(2);
  const httpGet = fakeHttpGet('example.com');
  const fetchUrl = fakeFetchUrl();
  const result = await runPilot({
    odsPath: __filename,
    hmrcAdapter: fakeAdapter(rows),
    client,
    throttleMs: 0,
  });
  for (const p of result.bundle.prefilterResults) {
    assert.equal(p.classification, 'NO_MATCH');
    assert.equal(p.finalBraveDecision, 'SEARCHED');
  }
});

test('runPilot: respects the Brave call budget cap (never exceeds CAPS.maxBraveCalls)', async () => {
  const client = createFakeClient();
  const rows = buildRows(3);
  const result = await runPilot({ odsPath: __filename, hmrcAdapter: fakeAdapter(rows), client, throttleMs: 0 });
  assert.ok(result.usage.braveCallsMade <= CAPS.maxBraveCalls);
});

test('runPilot: never persists to any Repository Authority table (safety) — fake client only ever sees domain_discovery_pilot_* tables', async () => {
  const client = createFakeClient();
  const rows = buildRows(2);
  await runPilot({ odsPath: __filename, hmrcAdapter: fakeAdapter(rows), client, throttleMs: 0 });
  const tableNames = Object.keys(client._tables);
  for (const name of tableNames) {
    assert.ok(name.startsWith('domain_discovery_pilot_'), `unexpected table touched: ${name}`);
  }
});
