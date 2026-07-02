'use strict';

// improvement-queue.test.js — tests createGetImprovementQueue's DI'd handler
// directly (no HTTP server). Aggregation/sorting logic predates this slice
// and is exercised incidentally; the focus here is the flag-gated
// portfolio-scoping behaviour this slice adds.

const { test } = require('node:test');
const assert = require('node:assert');

const { createGetImprovementQueue } = require('./improvement-queue');

function fakeRes() {
  const res = { body: null };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

const scanWithOneFail = (id) => ({
  id,
  scanner_results: [
    { name: 'Email Security', checks: [{ name: 'DMARC policy enforced', status: 'FAIL', details: 'p=none' }] },
  ],
});

const prospectA = { id: 'o1', firm_name: 'Smith LLP', website: 'smithllp.co.uk' };
const prospectB = { id: 'o2', firm_name: 'Doe & Co', website: 'doeandco.co.uk' };

function makeDeps(overrides = {}) {
  const calls = { getPortfolioItems: [] };
  const deps = {
    getProspects:    async () => [prospectA, prospectB],
    getScanHistory:  async (website) => [scanWithOneFail(`scan-${website}`)],
    getPortfolioItems: async (customerId) => { calls.getPortfolioItems.push(customerId); return []; },
    isPortfolioGateEnabled: () => false,
    ...overrides,
  };
  return { deps, calls };
}

test('empty prospect list → [] immediately, regardless of role or flag', async () => {
  const { deps } = makeDeps({ getProspects: async () => [] });
  const getImprovementQueue = createGetImprovementQueue(deps);
  const res = fakeRes();

  await getImprovementQueue({ user: { role: 'customer' }, tenant: null }, res, () => assert.fail());

  assert.deepStrictEqual(res.body, []);
});

test('flag disabled — customer sees the full, unscoped list (unchanged from pre-slice behaviour)', async () => {
  const { deps, calls } = makeDeps({ isPortfolioGateEnabled: () => false });
  const getImprovementQueue = createGetImprovementQueue(deps);
  const res = fakeRes();

  await getImprovementQueue({ user: { role: 'customer' }, tenant: null }, res, () => assert.fail());

  const orgIds = res.body.map(item => item.organisationId);
  assert.deepStrictEqual(new Set(orgIds), new Set(['o1', 'o2']));
  assert.strictEqual(calls.getPortfolioItems.length, 0, 'must not query the portfolio when the flag is off');
});

test('flag enabled — operations role still sees the full, platform-wide list (ADR-SYS-007 §3.4)', async () => {
  const { deps, calls } = makeDeps({ isPortfolioGateEnabled: () => true });
  const getImprovementQueue = createGetImprovementQueue(deps);
  const res = fakeRes();

  await getImprovementQueue({ user: { role: 'operations' }, tenant: null }, res, () => assert.fail());

  const orgIds = res.body.map(item => item.organisationId);
  assert.deepStrictEqual(new Set(orgIds), new Set(['o1', 'o2']));
  assert.strictEqual(calls.getPortfolioItems.length, 0);
});

test('flag enabled — customer with no tenant gets [] without querying scan history', async () => {
  const scanHistoryCalls = [];
  const { deps, calls } = makeDeps({
    isPortfolioGateEnabled: () => true,
    getScanHistory: async (website) => { scanHistoryCalls.push(website); return [scanWithOneFail('x')]; },
  });
  const getImprovementQueue = createGetImprovementQueue(deps);
  const res = fakeRes();

  await getImprovementQueue({ user: { role: 'customer' }, tenant: null }, res, () => assert.fail());

  assert.deepStrictEqual(res.body, []);
  assert.strictEqual(calls.getPortfolioItems.length, 0, 'no tenant means no portfolio to look up');
  assert.strictEqual(scanHistoryCalls.length, 0);
});

test('flag enabled — customer with an empty portfolio gets []', async () => {
  const { deps } = makeDeps({ isPortfolioGateEnabled: () => true, getPortfolioItems: async () => [] });
  const getImprovementQueue = createGetImprovementQueue(deps);
  const res = fakeRes();

  await getImprovementQueue(
    { user: { role: 'customer' }, tenant: { customer: { id: 'c1' } } },
    res,
    () => assert.fail()
  );

  assert.deepStrictEqual(res.body, []);
});

test('flag enabled — customer sees only prospects in their portfolio', async () => {
  const { deps } = makeDeps({
    isPortfolioGateEnabled: () => true,
    getPortfolioItems: async () => [{ organisationId: 'o1' }], // only Smith LLP is in the portfolio
  });
  const getImprovementQueue = createGetImprovementQueue(deps);
  const res = fakeRes();

  await getImprovementQueue(
    { user: { role: 'customer' }, tenant: { customer: { id: 'c1' } } },
    res,
    () => assert.fail()
  );

  const orgIds = res.body.map(item => item.organisationId);
  assert.deepStrictEqual(new Set(orgIds), new Set(['o1']));
});

test('items are sorted FAIL-priority first (pre-existing behaviour, unaffected by scoping)', async () => {
  const { deps } = makeDeps({
    getScanHistory: async (website) => [{
      id: `scan-${website}`,
      scanner_results: [{
        name: 'Email Security',
        checks: [
          { name: 'SPF present', status: 'WARNING', details: 'soft-fail' },
          { name: 'DMARC policy enforced', status: 'FAIL', details: 'p=none' },
        ],
      }],
    }],
  });
  const getImprovementQueue = createGetImprovementQueue(deps);
  const res = fakeRes();

  await getImprovementQueue({ user: { role: 'operations' }, tenant: null }, res, () => assert.fail());

  const priorities = res.body.map(i => i.priority);
  assert.strictEqual(priorities.indexOf('high') < priorities.lastIndexOf('medium'), true);
});

test('errors from a dependency go to next(err), not a crash', async () => {
  const boom = new Error('db unreachable');
  const { deps } = makeDeps({ getProspects: async () => { throw boom; } });
  const getImprovementQueue = createGetImprovementQueue(deps);
  let caught;

  await getImprovementQueue({ user: { role: 'operations' }, tenant: null }, fakeRes(), (err) => { caught = err; });

  assert.strictEqual(caught, boom);
});
