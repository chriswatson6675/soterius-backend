'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runScheduler } = require('./run-scheduler');

function emptyClassification() { return { due: [], future: [], suspended: [] }; }

function baseDeps(overrides = {}) {
  return {
    log: () => {},
    findDueCandidates: async () => [],
    classifyOrganisationDnsStates: async (organisationId, dueTypes) => ({ due: [...dueTypes], future: [], suspended: [] }),
    claimDueObservationStates: async (organisationId, types) => ({ claimed: true, claimedTypes: [...types], skippedTypes: [] }),
    observeOrganisationDnsSignals: async (organisationId, deps = {}) => ({
      organisationId, ok: true, domain: 'example.com',
      results: (deps.signalTypes || []).map((signal) => ({ signal, ok: true })),
    }),
    client: {},
    ...overrides,
  };
}

function candidate(organisationId, observationType) {
  return { organisationId, observationType };
}

describe('runScheduler — independent cadence (the core cadence-safety fix)', () => {
  test('only daily types due, weekly future — only daily types are claimed and collected', async () => {
    const claimed = [];
    const observed = [];
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'spf'), candidate('ORG-1', 'dkim'), candidate('ORG-1', 'dmarc')],
      claimDueObservationStates: async (id, types) => { claimed.push(...types); return { claimed: true, claimedTypes: types, skippedTypes: [] }; },
      observeOrganisationDnsSignals: async (id, d) => { observed.push(...d.signalTypes); return { organisationId: id, ok: true, domain: 'x', results: d.signalTypes.map((s) => ({ signal: s, ok: true })) }; },
    });
    const result = await runScheduler({ limit: 10 }, deps);
    assert.equal(result.ok, true);
    assert.deepStrictEqual(claimed.sort(), ['dkim', 'dmarc', 'spf']);
    assert.deepStrictEqual(observed.sort(), ['dkim', 'dmarc', 'spf']);
    assert.ok(!claimed.includes('dnssec'));
    assert.ok(!claimed.includes('caa'));
  });

  test('all five due — all five are claimed and collected', async () => {
    const deps = baseDeps({
      findDueCandidates: async () => ['spf', 'dkim', 'dmarc', 'dnssec', 'caa'].map((t) => candidate('ORG-1', t)),
    });
    const result = await runScheduler({ limit: 10 }, deps);
    assert.equal(result.results[0].results.length, 5);
  });

  test('only DNSSEC due — only DNSSEC executes', async () => {
    const observed = [];
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'dnssec')],
      observeOrganisationDnsSignals: async (id, d) => { observed.push(...d.signalTypes); return { organisationId: id, ok: true, domain: 'x', results: d.signalTypes.map((s) => ({ signal: s, ok: true })) }; },
    });
    await runScheduler({ limit: 10 }, deps);
    assert.deepStrictEqual(observed, ['dnssec']);
  });

  test('only CAA due — only CAA executes', async () => {
    const observed = [];
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'caa')],
      observeOrganisationDnsSignals: async (id, d) => { observed.push(...d.signalTypes); return { organisationId: id, ok: true, domain: 'x', results: d.signalTypes.map((s) => ({ signal: s, ok: true })) }; },
    });
    await runScheduler({ limit: 10 }, deps);
    assert.deepStrictEqual(observed, ['caa']);
  });

  test('a successful daily-only run never even attempts to claim the weekly types (not just "collects them last")', async () => {
    const claimCalls = [];
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'spf')],
      claimDueObservationStates: async (id, types) => { claimCalls.push(types); return { claimed: true, claimedTypes: types, skippedTypes: [] }; },
    });
    await runScheduler({ limit: 10 }, deps);
    assert.equal(claimCalls.length, 1);
    assert.deepStrictEqual(claimCalls[0], ['spf']);
  });
});

describe('runScheduler — --org preserves due eligibility (CLI-safety fix)', () => {
  test('a due named organisation is selected and runs only its due subset', async () => {
    const observed = [];
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'spf')],
      observeOrganisationDnsSignals: async (id, d) => { observed.push(id); return { organisationId: id, ok: true, domain: 'x', results: d.signalTypes.map((s) => ({ signal: s, ok: true })) }; },
    });
    const result = await runScheduler({ orgIds: ['ORG-1'] }, deps);
    assert.deepStrictEqual(result.cohort, ['ORG-1']);
    assert.deepStrictEqual(observed, ['ORG-1']);
  });

  test('a non-due named organisation performs NO collection at all (the actual bug this fixes)', async () => {
    let observeCalled = false;
    const deps = baseDeps({
      findDueCandidates: async () => [], // nothing due anywhere
      observeOrganisationDnsSignals: async () => { observeCalled = true; },
    });
    const result = await runScheduler({ orgIds: ['ORG-1'] }, deps);
    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.cohort, []);
    assert.equal(observeCalled, false);
  });

  test('mixed due/non-due named organisations: only the due one is selected', async () => {
    const deps = baseDeps({ findDueCandidates: async () => [candidate('ORG-1', 'spf')] });
    const result = await runScheduler({ orgIds: ['ORG-1', 'ORG-2'] }, deps);
    assert.deepStrictEqual(result.cohort, ['ORG-1']);
  });

  test('an organisation with some due and some not-due types runs only the due subset', async () => {
    const observed = [];
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'spf'), candidate('ORG-1', 'dkim')],
      observeOrganisationDnsSignals: async (id, d) => { observed.push(...d.signalTypes); return { organisationId: id, ok: true, domain: 'x', results: d.signalTypes.map((s) => ({ signal: s, ok: true })) }; },
    });
    await runScheduler({ orgIds: ['ORG-1'] }, deps);
    assert.deepStrictEqual(observed.sort(), ['dkim', 'spf']);
  });
});

describe('runScheduler — --force-org (explicit bypass, clearly opt-in)', () => {
  test('forces a non-due organisation to run all five signals, with a clear warning logged', async () => {
    const lines = [];
    const observed = [];
    const deps = baseDeps({
      log: (m) => lines.push(m),
      findDueCandidates: async () => [],
      observeOrganisationDnsSignals: async (id, d) => { observed.push(...d.signalTypes); return { organisationId: id, ok: true, domain: 'x', results: d.signalTypes.map((s) => ({ signal: s, ok: true })) }; },
    });
    const result = await runScheduler({ orgIds: ['ORG-1'], forceOrg: true }, deps);
    assert.equal(result.ok, true);
    assert.deepStrictEqual(observed.sort(), ['caa', 'dkim', 'dmarc', 'dnssec', 'spf']);
    assert.ok(lines.some((l) => l.includes('WARNING') && l.includes('bypasses cadence eligibility')));
  });

  test('refuses --force-org without any --org', async () => {
    const result = await runScheduler({ forceOrg: true }, baseDeps());
    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
    assert.match(result.reason, /requires at least one explicit --org/);
  });

  test('refuses --force-org combined with --production', async () => {
    const result = await runScheduler({ orgIds: ['ORG-1'], forceOrg: true, productionUnbounded: true }, baseDeps());
    assert.equal(result.ok, false);
    assert.match(result.reason, /cannot be combined with --production/);
  });
});

describe('runScheduler — --now safety (Option A: dry-run only)', () => {
  test('refuses a real (non-dry-run) execution when --now is set', async () => {
    const result = await runScheduler({ orgIds: ['ORG-1'], now: '2099-01-01T00:00:00.000Z', dryRun: false }, baseDeps());
    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
    assert.match(result.reason, /only permitted together with --dry-run/);
  });

  test('permits --now when combined with --dry-run', async () => {
    const deps = baseDeps({ findDueCandidates: async () => [candidate('ORG-1', 'spf')] });
    const result = await runScheduler({ limit: 10, now: '2099-01-01T00:00:00.000Z', dryRun: true }, deps);
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
  });

  test('a real run never threads a future --now into a claim timestamp — real wall clock always used', async () => {
    let claimNowIso = null;
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'spf')],
      claimDueObservationStates: async (id, types, callDeps) => { claimNowIso = callDeps.now(); return { claimed: true, claimedTypes: types, skippedTypes: [] }; },
    });
    const before = Date.now();
    await runScheduler({ orgIds: ['ORG-1'] }, deps); // no --now at all
    const after = Date.now();
    const claimTime = Date.parse(claimNowIso);
    assert.ok(claimTime >= before && claimTime <= after, 'claim timestamp must be real wall-clock time');
  });
});

describe('runScheduler — dry-run', () => {
  test('performs no claiming and no collection', async () => {
    let claimCalled = false;
    let observeCalled = false;
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'spf')],
      claimDueObservationStates: async () => { claimCalled = true; return { claimed: true, claimedTypes: [], skippedTypes: [] }; },
      observeOrganisationDnsSignals: async () => { observeCalled = true; },
    });
    const result = await runScheduler({ limit: 5, dryRun: true }, deps);
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(claimCalled, false);
    assert.equal(observeCalled, false);
  });

  test('dry-run reports due/future/suspended/planned types per organisation', async () => {
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'spf')],
      classifyOrganisationDnsStates: async () => ({ due: ['spf'], future: ['dnssec', 'caa'], suspended: [] }),
    });
    const result = await runScheduler({ limit: 5, dryRun: true }, deps);
    assert.equal(result.plan[0].organisationId, 'ORG-1');
    assert.deepStrictEqual(result.plan[0].classification.future.sort(), ['caa', 'dnssec']);
    assert.deepStrictEqual(result.plan[0].typesToProcess, ['spf']);
  });
});

describe('runScheduler — bounding', () => {
  test('refuses an unbounded run by default', async () => {
    const result = await runScheduler({}, baseDeps());
    assert.equal(result.ok, false);
    assert.equal(result.refused, true);
  });

  test('--limit counts unique due organisations, not raw states', async () => {
    const deps = baseDeps({
      findDueCandidates: async () => [
        candidate('ORG-1', 'spf'), candidate('ORG-1', 'dkim'), candidate('ORG-1', 'dmarc'),
        candidate('ORG-2', 'spf'),
      ],
    });
    const result = await runScheduler({ limit: 1 }, deps);
    assert.deepStrictEqual(result.cohort, ['ORG-1']);
  });

  test('an explicit production flag runs every currently-due organisation, never a forced non-due one', async () => {
    const deps = baseDeps({ findDueCandidates: async () => [candidate('ORG-1', 'spf'), candidate('ORG-2', 'dkim')] });
    const result = await runScheduler({ productionUnbounded: true }, deps);
    assert.deepStrictEqual(result.cohort.sort(), ['ORG-1', 'ORG-2']);
  });
});

describe('runScheduler — summary counts', () => {
  test('distinguishes selected/claimed/completed/failed/skipped-future/skipped-suspended-or-claimed', async () => {
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'spf'), candidate('ORG-1', 'dkim')],
      classifyOrganisationDnsStates: async () => ({ due: ['spf', 'dkim'], future: ['dnssec'], suspended: ['caa'] }),
      claimDueObservationStates: async (id, types) => ({ claimed: true, claimedTypes: types, skippedTypes: [] }),
      observeOrganisationDnsSignals: async (id, d) => ({
        organisationId: id, ok: true, domain: 'x',
        results: [{ signal: 'spf', ok: true }, { signal: 'dkim', ok: false, error: 'NXDOMAIN' }],
      }),
    });
    const result = await runScheduler({ orgIds: ['ORG-1'] }, deps);
    assert.equal(result.summary.organisationsSelected, 1);
    assert.equal(result.summary.statesSelected, 2);
    assert.equal(result.summary.statesClaimed, 2);
    assert.equal(result.summary.statesCompleted, 1);
    assert.equal(result.summary.statesFailed, 1);
    assert.equal(result.summary.statesSkippedFuture, 1);
    assert.equal(result.summary.statesSkippedSuspendedOrClaimed, 1);
  });

  test('a claim contention loss increments skipped-suspended-or-claimed, not claimed', async () => {
    const deps = baseDeps({
      findDueCandidates: async () => [candidate('ORG-1', 'spf'), candidate('ORG-1', 'dkim')],
      claimDueObservationStates: async () => ({ claimed: true, claimedTypes: ['spf'], skippedTypes: [{ observationType: 'dkim', reason: 'already running elsewhere' }] }),
    });
    const result = await runScheduler({ orgIds: ['ORG-1'] }, deps);
    assert.equal(result.summary.statesClaimed, 1);
    assert.equal(result.summary.statesSkippedSuspendedOrClaimed, 1);
  });
});

describe('runScheduler — determinism', () => {
  test('an explicit --now (with --dry-run) is honoured for selection, not the real clock', async () => {
    let seenNow = null;
    const deps = baseDeps({ findDueCandidates: async (args) => { seenNow = args.now; return []; } });
    await runScheduler({ now: '2026-08-01T00:00:00.000Z', dryRun: true, limit: 5 }, deps);
    assert.equal(seenNow, '2026-08-01T00:00:00.000Z');
  });
});
