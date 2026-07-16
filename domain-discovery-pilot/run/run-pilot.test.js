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

test('runPilot: persists the complete provenance chain candidate -> prefilter -> query -> search_result -> page_fetch -> evidence -> decision', async () => {
  const client = createFakeClient();
  const rows = buildRows(1);
  const httpGet = fakeHttpGet('example.com');
  const fetchUrlFake = fakeFetchUrl();

  const result = await runPilot({
    odsPath: __filename,
    hmrcAdapter: fakeAdapter(rows),
    client,
    throttleMs: 0,
    braveDeps: { httpGet, apiKey: 'test-key' },
    fetchDeps: { fetchUrl: fetchUrlFake },
  });

  assert.equal(result.bundle.candidates.length, 1);
  const candidateId = client._tables.domain_discovery_pilot_candidates[0].id;

  const prefilterRows = client._tables.domain_discovery_pilot_prefilter.filter((r) => r.candidate_id === candidateId);
  assert.equal(prefilterRows.length, 1);

  const queryRows = client._tables.domain_discovery_pilot_queries.filter((r) => r.candidate_id === candidateId);
  assert.ok(queryRows.length >= 1, 'at least one query must be persisted');

  const searchResultRows = client._tables.domain_discovery_pilot_search_results.filter((r) =>
    queryRows.some((q) => q.id === r.query_id));
  assert.ok(searchResultRows.length >= 1, 'search_results must not be empty — this is the fix under test');
  for (const sr of searchResultRows) {
    assert.ok(sr.url, 'each search_result must retain its url');
    assert.ok(sr.retrieved_at, 'each search_result must retain a retrieval time');
  }

  const pageFetchRows = client._tables.domain_discovery_pilot_page_fetches.filter((r) => r.candidate_id === candidateId);
  assert.ok(pageFetchRows.length >= 1, 'at least one page_fetch must be persisted');
  assert.ok(
    pageFetchRows.some((pf) => searchResultRows.some((sr) => sr.id === pf.search_result_id)),
    'the candidate homepage fetch must be traceable back to a real search_result id, not null',
  );

  const evidenceRows = client._tables.domain_discovery_pilot_evidence.filter((r) => r.candidate_id === candidateId);
  assert.ok(evidenceRows.length >= 1, 'at least one evidence row must be persisted');
  assert.ok(
    pageFetchRows.some((pf) => evidenceRows.some((e) => e.page_fetch_id === pf.id)),
    'evidence must link back to the page_fetch it was extracted from',
  );

  const decisionRows = client._tables.domain_discovery_pilot_decisions.filter((r) => r.candidate_id === candidateId);
  assert.equal(decisionRows.length, 1, 'exactly one decision per candidate');
});

test('runPilot: a second result for an already-memoised domain still gets its own search_result row, without a second page_fetch', async () => {
  const client = createFakeClient();
  const rows = buildRows(1);
  // Two Brave results pointing at the SAME domain (e.g. two different
  // queries both surfacing firm1.example.com) — both must be persisted as
  // distinct search_results, but fetchCandidatePages must only run once.
  let fetchCallCount = 0;
  const httpGet = async () => ({
    status: 200,
    headers: {},
    data: { web: { results: [{ url: 'https://firm1.example.com/', title: 'Firm', description: 'd' }] } },
  });
  const fetchUrlFake = async (url) => {
    fetchCallCount += 1;
    return {
      success: true, requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html',
      body: '<html><head><title>Test Firm Limited</title></head><body>Test Firm Limited</body></html>',
      retrievedAt: '2026-07-15T00:00:00.000Z',
    };
  };

  await runPilot({
    odsPath: __filename,
    hmrcAdapter: fakeAdapter(rows),
    client,
    throttleMs: 0,
    braveDeps: { httpGet, apiKey: 'test-key' },
    fetchDeps: { fetchUrl: fetchUrlFake },
  });

  const searchResultRows = client._tables.domain_discovery_pilot_search_results;
  // Two query templates both return the same URL -> two distinct search_result rows.
  assert.equal(searchResultRows.length, 2);
  const pageFetchRows = client._tables.domain_discovery_pilot_page_fetches;
  // Only the FIRST occurrence triggers a page fetch; the memoised repeat does not.
  assert.equal(pageFetchRows.length, 1);
  assert.equal(pageFetchRows[0].search_result_id, searchResultRows[0].id);
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
