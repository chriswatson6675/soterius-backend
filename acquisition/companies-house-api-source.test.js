'use strict';

// companies-house-api-source.test.js — by-SIC advanced-search streaming (stubbed transport).

const { test } = require('node:test');
const assert = require('node:assert');

const { streamAdvancedSearchBySic, companiesHouseApiCandidateSource } = require('./companies-house-api-source');

async function collect(it) { const out = []; for await (const x of it) out.push(x); return out; }

// Stub ch-client.getJson: serves `total` synthetic active companies for each SIC code,
// paged by start_index/size. Records every URL requested.
function makeStubGetJson(totals, requested = []) {
  return async (url) => {
    requested.push(url);
    const code = /sic_codes=([^&]+)/.exec(url)[1];
    const size = +(/size=(\d+)/.exec(url)[1]);
    const start = +(/start_index=(\d+)/.exec(url)[1]);
    const total = totals[code] || 0;
    const items = [];
    for (let i = start; i < Math.min(start + size, total); i++) {
      items.push({ company_number: `${code}-${i}`, company_name: `Firm ${code} ${i} Limited`, company_status: 'active', sic_codes: [code] });
    }
    return { errorType: 'NONE', httpStatus: 200, body: { hits: total, items } };
  };
}

test('pages a SIC code and yields raw records until exhausted', async () => {
  const requested = [];
  const recs = await collect(streamAdvancedSearchBySic({ apiKey: 'K', sicCodes: ['66190'], pageSize: 100, pace: 0, _getJson: makeStubGetJson({ '66190': 250 }, requested) }));
  assert.strictEqual(recs.length, 250);
  assert.strictEqual(requested.length, 3, '3 pages (100,100,50)');
  assert.deepStrictEqual(recs[0], { companyNumber: '66190-0', companyName: 'Firm 66190 0 Limited', status: 'active', sicCodes: ['66190'] });
});

test('iterates multiple SIC codes', async () => {
  const recs = await collect(streamAdvancedSearchBySic({ apiKey: 'K', sicCodes: ['64191', '66300'], pageSize: 100, pace: 0, _getJson: makeStubGetJson({ '64191': 50, '66300': 30 }) }));
  assert.strictEqual(recs.length, 80);
  assert.strictEqual(recs.filter((r) => r.sicCodes[0] === '64191').length, 50);
  assert.strictEqual(recs.filter((r) => r.sicCodes[0] === '66300').length, 30);
});

test('respects the ~cap and logs the dropped tail (no silent truncation)', async () => {
  const logs = [];
  const recs = await collect(streamAdvancedSearchBySic({ apiKey: 'K', sicCodes: ['66190'], pageSize: 100, maxPerSic: 300, pace: 0, log: (m) => logs.push(m), _getJson: makeStubGetJson({ '66190': 1000 }) }));
  assert.strictEqual(recs.length, 300, 'stops at the cap');
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /exceed the ~300 advanced-search cap — 700 not retrieved/);
});

test('retries transient errors then throws if they persist (propagation)', async () => {
  let calls = 0;
  const getJson = async () => { calls++; return { errorType: 'RATE_LIMITED', httpStatus: 429, body: null }; };
  await assert.rejects(
    collect(streamAdvancedSearchBySic({ apiKey: 'K', sicCodes: ['66190'], pace: 0, retryAttempts: 3, retryDelay: 0, _getJson: getJson })),
    /CH advanced-search 66190 failed: RATE_LIMITED 429/,
  );
  assert.strictEqual(calls, 3, 'retried up to the attempt limit');
});

test('recovers from a transient blip: retries then succeeds', async () => {
  let calls = 0;
  const getJson = async (url) => {
    calls++;
    if (calls === 1) return { errorType: 'CONNECTION_ERROR', httpStatus: null, body: null }; // first attempt blips
    return { errorType: 'NONE', httpStatus: 200, body: { hits: 1, items: [{ company_number: 'X', company_name: 'Y Ltd', company_status: 'active', sic_codes: ['66190'] }] } };
  };
  const recs = await collect(streamAdvancedSearchBySic({ apiKey: 'K', sicCodes: ['66190'], pace: 0, retryDelay: 0, _getJson: getJson }));
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(calls, 2, 'retried once then succeeded');
});

test('companiesHouseApiCandidateSource yields filtered {companyNumber, companyName, sicCodes}', async () => {
  const out = await collect(companiesHouseApiCandidateSource({ apiKey: 'K', sicCodes: ['66190'], pageSize: 100, pace: 0, _getJson: makeStubGetJson({ '66190': 2 }) }));
  assert.deepStrictEqual(out, [
    { companyNumber: '66190-0', companyName: 'Firm 66190 0 Limited', sicCodes: ['66190'] },
    { companyNumber: '66190-1', companyName: 'Firm 66190 1 Limited', sicCodes: ['66190'] },
  ]);
});

test('streams lazily — early break stops paging (no full buffering)', async () => {
  const requested = [];
  const src = streamAdvancedSearchBySic({ apiKey: 'K', sicCodes: ['66190'], pageSize: 100, pace: 0, _getJson: makeStubGetJson({ '66190': 100000 }, requested) });
  let n = 0;
  for await (const _ of src) { if (++n === 5) break; }
  assert.strictEqual(n, 5);
  assert.strictEqual(requested.length, 1, 'only the first page was fetched');
});
