'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('./run-scheduled-sweep-cli');

describe('governance gate (ENG-032 remains Draft/HOLD)', () => {
  test('is a no-op — never calls listOrganisationIds or the sweep — when deps.enabled is false', async () => {
    let called = false;
    const outcome = await main({
      deps: {
        enabled: false,
        listOrganisationIds: async () => { called = true; return []; },
        runScheduledSweep: async () => { called = true; return { processed: [], skipped: [], failed: [] }; },
      },
    });
    assert.strictEqual(outcome.skipped, true);
    assert.strictEqual(called, false);
  });

  test('runs the sweep when deps.enabled is true', async () => {
    const outcome = await main({
      deps: {
        enabled: true,
        listOrganisationIds: async () => ['ORG-1', 'ORG-2'],
        runScheduledSweep: async () => ({ processed: [{ organisationId: 'ORG-1' }], skipped: [], failed: [] }),
        recordCompletedRun: async () => {},
        now: () => '2026-07-13T00:00:00.000Z',
      },
    });
    assert.strictEqual(outcome.skipped, false);
    assert.strictEqual(outcome.result.processed.length, 1);
  });
});

describe('metrics recording', () => {
  test('records a completed run with the population total and sweep result', async () => {
    let captured = null;
    await main({
      deps: {
        enabled: true,
        listOrganisationIds: async () => ['ORG-1', 'ORG-2', 'ORG-3'],
        runScheduledSweep: async () => ({ processed: [{ organisationId: 'ORG-1' }], skipped: [{ organisationId: 'ORG-2' }], failed: [] }),
        recordCompletedRun: async (args) => { captured = args; },
        now: () => '2026-07-13T00:00:00.000Z',
      },
    });
    assert.strictEqual(captured.populationTotal, 3);
    assert.strictEqual(captured.result.processed.length, 1);
  });

  test('records a crashed run and rethrows when the sweep invocation itself throws', async () => {
    let captured = null;
    await assert.rejects(
      main({
        deps: {
          enabled: true,
          listOrganisationIds: async () => [],
          runScheduledSweep: async () => { throw new Error('policyThresholdMs must be a positive, finite number'); },
          recordCrashedRun: async (args) => { captured = args; },
          now: () => '2026-07-13T00:00:00.000Z',
        },
      }),
      /policyThresholdMs must be a positive, finite number/,
    );
    assert.ok(captured);
    assert.strictEqual(captured.reason, 'policyThresholdMs must be a positive, finite number');
  });

  test('still records a crashed run even when population enumeration itself failed (populationTotal falls back to null)', async () => {
    let captured = null;
    await assert.rejects(
      main({
        deps: {
          enabled: true,
          listOrganisationIds: async () => { throw new Error('dataset unreadable'); },
          runScheduledSweep: async () => { throw new Error('population enumeration failed: dataset unreadable'); },
          recordCrashedRun: async (args) => { captured = args; },
          now: () => '2026-07-13T00:00:00.000Z',
        },
      }),
    );
    assert.ok(captured);
  });
});

describe('policy threshold parsing', () => {
  test('rejects a non-positive TRUST_PROFILE_SWEEP_POLICY_THRESHOLD_MS as a crashed run, not a silent default', async () => {
    const original = process.env.TRUST_PROFILE_SWEEP_POLICY_THRESHOLD_MS;
    process.env.TRUST_PROFILE_SWEEP_POLICY_THRESHOLD_MS = '-5';
    try {
      await assert.rejects(
        main({ deps: { enabled: true, listOrganisationIds: async () => [], recordCrashedRun: async () => {}, now: () => '2026-07-13T00:00:00.000Z' } }),
        /TRUST_PROFILE_SWEEP_POLICY_THRESHOLD_MS must be a positive number/,
      );
    } finally {
      if (original === undefined) delete process.env.TRUST_PROFILE_SWEEP_POLICY_THRESHOLD_MS;
      else process.env.TRUST_PROFILE_SWEEP_POLICY_THRESHOLD_MS = original;
    }
  });
});
