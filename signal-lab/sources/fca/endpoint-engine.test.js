'use strict';

// endpoint-engine.test.js — Phase 3 execution engine tests (IMP-FCA-001 §3).

const { test } = require('node:test');
const assert = require('node:assert');
const { executeAnchor } = require('./endpoint-engine');

const BASE = 'https://register.fca.org.uk/services/V0.1';
const CONFIG = { baseUrl: BASE, email: 'e@x', apiKey: 'k' };

/** Build an injectable transport from a map of URL → response body object (records call order). */
function routedFetch(routes) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    // longest-prefix-ish: exact match first, else startsWith
    const exact = routes[url];
    const body = exact !== undefined ? exact : (Object.entries(routes).find(([k]) => url.startsWith(k)) || [])[1];
    if (body === undefined) return { statusCode: 200, headers: {}, bodyBuffer: Buffer.from(JSON.stringify({ Status: 'FSR-API-XX-21', Data: null })) };
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, bodyBuffer: Buffer.from(JSON.stringify(body)) };
  };
  return { fetchFn, calls };
}

test('parent executes before children (deterministic order)', async () => {
  const { fetchFn, calls } = routedFetch({
    [`${BASE}/Firm/1`]: { Status: 'FSR-API-02-01-00', Data: [{ FRN: '1' }] },
    [`${BASE}/Firm/1/Address`]: { Status: 'FSR-API-02-02-00', Data: [{ 'Website Address': 'x' }] },
    [`${BASE}/Firm/1/Regulators`]: { Status: 'FSR-API-02-09-00', Data: [{ 'Regulator Name': 'FCA' }] },
  });
  const out = await executeAnchor({ family: 'firm', anchor: '1', config: CONFIG, endpoints: ['firm', 'firm.address', 'firm.regulators'], _fetch: fetchFn });
  assert.deepStrictEqual(out.order, ['firm', 'firm.address', 'firm.regulators']);
  assert.ok(calls[0].endsWith('/Firm/1'), 'parent fetched first');
  assert.strictEqual(out.executions.length, 3);
  assert.ok(out.executions.every((e) => e.status === 'executed'));
});

test('pagination: follows ResultInfo.Next to completion', async () => {
  const { fetchFn, calls } = routedFetch({
    [`${BASE}/Firm/1`]: { Status: 'FSR-API-02-01-00', Data: [{ FRN: '1' }] },
    [`${BASE}/Firm/1/Names`]: { Status: 'FSR-API-02-04-00', ResultInfo: { Next: `${BASE}/Firm/1/Names?pgnp=2` }, Data: [{ 'Current Names': [] }] },
    [`${BASE}/Firm/1/Names?pgnp=2`]: { Status: 'FSR-API-02-04-00', ResultInfo: { Next: `${BASE}/Firm/1/Names?pgnp=3` }, Data: [{}] },
    [`${BASE}/Firm/1/Names?pgnp=3`]: { Status: 'FSR-API-02-04-00', ResultInfo: {}, Data: [{}] },
  });
  const out = await executeAnchor({ family: 'firm', anchor: '1', config: CONFIG, endpoints: ['firm', 'firm.names'], _fetch: fetchFn });
  const names = out.executions.find((e) => e.endpointId === 'firm.names');
  assert.strictEqual(names.pages.length, 3, 'three pages followed via Next');
  assert.ok(calls.includes(`${BASE}/Firm/1/Names?pgnp=3`));
});

test('within-entity grandchild: one request per dependency id', async () => {
  const { fetchFn, calls } = routedFetch({
    [`${BASE}/Firm/1`]: { Status: 'FSR-API-02-01-00', Data: [{ FRN: '1' }] },
    [`${BASE}/Firm/1/Requirements`]: { Status: 'FSR-API-02-06-00', Data: [{ 'Requirement Reference': 'OR-1' }, { 'Requirement Reference': 'OR-2' }] },
    [`${BASE}/Firm/1/Requirements/OR-1/InvestmentTypes`]: { Status: 'FSR-API-02-13-11', Data: null },
    [`${BASE}/Firm/1/Requirements/OR-2/InvestmentTypes`]: { Status: 'FSR-API-02-13-11', Data: null },
  });
  const out = await executeAnchor({ family: 'firm', anchor: '1', config: CONFIG, endpoints: ['firm', 'firm.requirements', 'firm.requirements.investmentTypes'], _fetch: fetchFn });
  const grand = out.executions.filter((e) => e.endpointId === 'firm.requirements.investmentTypes');
  assert.strictEqual(grand.length, 2, 'one grandchild execution per requirement ref');
  assert.deepStrictEqual(grand.map((g) => g.dependencyId).sort(), ['OR-1', 'OR-2']);
});

test('grandchild with no dependency ids → dependency-empty (no request)', async () => {
  const { fetchFn } = routedFetch({
    [`${BASE}/Firm/1`]: { Status: 'FSR-API-02-01-00', Data: [{ FRN: '1' }] },
    [`${BASE}/Firm/1/Passports`]: { Status: 'FSR-API-02-07-00', Data: [{ Passports: [] }] },
  });
  const out = await executeAnchor({ family: 'firm', anchor: '1', config: CONFIG, endpoints: ['firm', 'firm.passports', 'firm.passports.permission'], _fetch: fetchFn });
  const perm = out.executions.find((e) => e.endpointId === 'firm.passports.permission');
  assert.strictEqual(perm.status, 'dependency-empty');
  assert.strictEqual(perm.pages.length, 0);
});

test('dynamic structures are returned EXACTLY as received [CR-FCA-04/15]', async () => {
  const permissionsBody = {
    Status: 'FSR-API-02-03-00',
    Data: { 'Accepting Deposits': [{ 'Customer Type': ['Customer'] }], 'Debt Adjusting': [{ Limitation: ['no debt management'] }] },
  };
  const { fetchFn } = routedFetch({
    [`${BASE}/Firm/1`]: { Status: 'FSR-API-02-01-00', Data: [{ FRN: '1' }] },
    [`${BASE}/Firm/1/Permissions`]: permissionsBody,
  });
  const out = await executeAnchor({ family: 'firm', anchor: '1', config: CONFIG, endpoints: ['firm', 'firm.permissions'], _fetch: fetchFn });
  const perms = out.executions.find((e) => e.endpointId === 'firm.permissions');
  // returned verbatim — dynamic activity-keyed map intact, no transformation
  assert.deepStrictEqual(perms.pages[0].response.body, permissionsBody);
});

test('cross-entity links are NEVER traversed: only catalogue endpoints are executed [CR-FCA-13]', async () => {
  // The AR body references OTHER firms (FRNs 496326 etc). The engine must not fetch them.
  const { fetchFn, calls } = routedFetch({
    [`${BASE}/Firm/1`]: { Status: 'FSR-API-02-01-00', Data: [{ FRN: '1' }] },
    [`${BASE}/Firm/1/AR`]: {
      Status: 'FSR-API-05-04-00',
      Data: { PreviousAppointedRepresentatives: [{ FRN: '496326', URL: `${BASE}/Firm/496326`, 'Principal FRN': '1' }] },
    },
  });
  const out = await executeAnchor({ family: 'firm', anchor: '1', config: CONFIG, endpoints: ['firm', 'firm.ar'], _fetch: fetchFn });
  assert.strictEqual(out.executions.length, 2);
  assert.ok(!calls.some((u) => u.includes('/Firm/496326')), 'must NOT fetch the cross-entity AR firm');
});

test('maxPagesPerEndpoint is honoured and flagged honestly (never a silent cap)', async () => {
  const { fetchFn } = routedFetch({
    [`${BASE}/Firm/1`]: { Status: 'FSR-API-02-01-00', Data: [{ FRN: '1' }] },
    [`${BASE}/Firm/1/Names`]: { Status: 'FSR-API-02-04-00', ResultInfo: { Next: `${BASE}/Firm/1/Names?pgnp=2` }, Data: [{}] },
    [`${BASE}/Firm/1/Names?pgnp=2`]: { Status: 'FSR-API-02-04-00', ResultInfo: { Next: `${BASE}/Firm/1/Names?pgnp=3` }, Data: [{}] },
  });
  const out = await executeAnchor({ family: 'firm', anchor: '1', config: CONFIG, endpoints: ['firm', 'firm.names'], _fetch: fetchFn, maxPagesPerEndpoint: 1 });
  const names = out.executions.find((e) => e.endpointId === 'firm.names');
  assert.strictEqual(names.pages.length, 1);
  assert.strictEqual(names.pageLimitReached, true, 'truncation is explicitly flagged');
});
