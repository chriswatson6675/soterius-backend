'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runScheduler } = require('./run-scheduler');

function candidate(organisationId, observationType) {
  return { organisationId, observationType, nextDueAt: null, status: 'never_observed', updatedAt: null };
}

function baseDeps(overrides = {}) {
  return {
    log: () => {},
    findDueCandidates: async () => [candidate('ORG-1', 'spf'), candidate('ORG-2', 'spf'), candidate('ORG-3', 'spf')],
    claimOrganisationDnsStates: async (organisationId) => ({ claimed: true, claimedTypes: ['spf'] }),
    observeOrganisationDnsSignals: async (organisationId) => ({
      organisationId, ok: true, domain: 'example.com',
      results: ['spf', 'dkim', 'dmarc', 'dnssec', 'caa'].map((signal) => ({ signal, ok: true })),
    }),
    client: {},
    ...overrides,
  };
}

describe('runScheduler — bounding', () => {
  test('refuses an unbounded run by default (no --org, no --limit)', async () => {
    let observeCalled = false;
    const result = await runScheduler({}, baseDeps({ observeOrganisationDnsSignals: async () => { observeCalled = true; } }));
    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
    assert.equal(observeCalled, false);
  });

  test('a bounded --limit is respected — only that many organisations run', async () => {
    const observed = [];
    const result = await runScheduler(
      { limit: 2 },
      baseDeps({ observeOrganisationDnsSignals: async (id) => { observed.push(id); return { organisationId: id, ok: true, domain: 'x', results: [] }; } }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.cohort.length, 2);
    assert.equal(observed.length, 2);
  });

  test('explicit --org filtering runs exactly the given organisations, regardless of due-ness', async () => {
    const observed = [];
    const result = await runScheduler(
      { orgIds: ['ORG-99'] },
      baseDeps({ observeOrganisationDnsSignals: async (id) => { observed.push(id); return { organisationId: id, ok: true, domain: 'x', results: [] }; } }),
    );
    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.cohort, ['ORG-99']);
    assert.deepStrictEqual(observed, ['ORG-99']);
  });

  test('an explicit production flag allows an unbounded run — but only across currently-due organisations, never the full registry', async () => {
    const observed = [];
    const result = await runScheduler(
      { productionUnbounded: true },
      baseDeps({ observeOrganisationDnsSignals: async (id) => { observed.push(id); return { organisationId: id, ok: true, domain: 'x', results: [] }; } }),
    );
    assert.equal(result.ok, true);
    assert.deepStrictEqual(observed.sort(), ['ORG-1', 'ORG-2', 'ORG-3']);
  });
});

describe('runScheduler — grouping', () => {
  test('due candidates are grouped by organisation — one observe call per organisation, not per signal', async () => {
    const observeCalls = [];
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'spf'), candidate('ORG-1', 'dkim'), candidate('ORG-1', 'dmarc')],
      observeOrganisationDnsSignals: async (id) => { observeCalls.push(id); return { organisationId: id, ok: true, domain: 'x', results: [] }; },
    });
    await runScheduler({ limit: 10 }, deps);
    assert.deepStrictEqual(observeCalls, ['ORG-1']);
  });
});

describe('runScheduler — dry run', () => {
  test('performs no claiming and no collection', async () => {
    let claimCalled = false;
    let observeCalled = false;
    const result = await runScheduler(
      { limit: 5, dryRun: true },
      baseDeps({
        claimOrganisationDnsStates: async () => { claimCalled = true; return { claimed: true, claimedTypes: [] }; },
        observeOrganisationDnsSignals: async () => { observeCalled = true; },
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(claimCalled, false);
    assert.equal(observeCalled, false);
  });
});

describe('runScheduler — claim contention', () => {
  test('a skipped (unclaimable) organisation is recorded as skipped, not attempted', async () => {
    const result = await runScheduler(
      { limit: 5 },
      baseDeps({ claimOrganisationDnsStates: async () => ({ claimed: false, reason: 'already running elsewhere' }) }),
    );
    assert.equal(result.summary.skipped, 3);
    assert.equal(result.summary.claimed, 0);
    assert.ok(result.results.every((r) => r.skipped));
  });
});

describe('runScheduler — success/failure summary', () => {
  test('a fully successful organisation counts as completed', async () => {
    const result = await runScheduler({ orgIds: ['ORG-1'] }, baseDeps());
    assert.equal(result.summary.completed, 1);
    assert.equal(result.summary.failed, 0);
  });

  test('an organisation with any failed signal counts as failed, not completed', async () => {
    const deps = baseDeps({
      observeOrganisationDnsSignals: async (id) => ({
        organisationId: id, ok: true, domain: 'x',
        results: [{ signal: 'spf', ok: true }, { signal: 'dkim', ok: false, error: 'NXDOMAIN' }],
      }),
    });
    const result = await runScheduler({ orgIds: ['ORG-1'] }, deps);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.completed, 0);
  });

  test('an organisation with no resolvable domain (observeOrganisationDnsSignals itself fails) counts as failed', async () => {
    const deps = baseDeps({ observeOrganisationDnsSignals: async (id) => ({ organisationId: id, ok: false, error: 'no verifiedDomain' }) });
    const result = await runScheduler({ orgIds: ['ORG-1'] }, deps);
    assert.equal(result.summary.failed, 1);
  });
});

describe('runScheduler — determinism', () => {
  test('an explicit --now is honoured, not the real clock', async () => {
    let seenNow = null;
    const deps = baseDeps({ findDueCandidates: async (args) => { seenNow = args.now; return []; } });
    await runScheduler({ now: '2026-08-01T00:00:00.000Z', limit: 5 }, deps);
    assert.equal(seenNow, '2026-08-01T00:00:00.000Z');
  });
});
