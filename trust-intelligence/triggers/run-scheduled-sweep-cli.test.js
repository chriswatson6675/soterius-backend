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

describe('bounded manual trial mode (pre-production validation phase, 2026-07-16)', () => {
  function withEnv(vars, fn) {
    const originals = {};
    for (const key of Object.keys(vars)) originals[key] = process.env[key];
    Object.assign(process.env, vars);
    return fn().finally(() => {
      for (const key of Object.keys(vars)) {
        if (originals[key] === undefined) delete process.env[key];
        else process.env[key] = originals[key];
      }
    });
  }

  test('TRUST_PROFILE_SWEEP_TRIAL_ORG_IDS restricts both populationTotal and the cohort passed to the sweep', () => withEnv(
    { TRUST_PROFILE_SWEEP_TRIAL_ORG_IDS: 'ORG-A, ORG-B' },
    async () => {
      let sweepDeps = null;
      const outcome = await main({
        deps: {
          enabled: true,
          runScheduledSweep: async (args) => { sweepDeps = args.deps; return { processed: [], skipped: [], failed: [] }; },
          recordCompletedRun: async () => {},
          now: () => '2026-07-13T00:00:00.000Z',
        },
      });
      assert.strictEqual(outcome.skipped, false);
      assert.deepStrictEqual(await sweepDeps.listOrganisationIds(), ['ORG-A', 'ORG-B']);
    },
  ));

  test('TRUST_PROFILE_SWEEP_TRIAL_LIMIT takes a deterministic prefix of the real population', () => withEnv(
    { TRUST_PROFILE_SWEEP_TRIAL_LIMIT: '2' },
    async () => {
      let captured = null;
      await main({
        deps: {
          enabled: true,
          listOrganisationIds: undefined,
          runScheduledSweep: async (args) => { captured = await args.deps.listOrganisationIds(); return { processed: [], skipped: [], failed: [] }; },
          recordCompletedRun: async () => {},
          now: () => '2026-07-13T00:00:00.000Z',
        },
      });
      assert.strictEqual(captured.length, 2);
    },
  ));

  test('an explicit deps.listOrganisationIds (test injection) overrides trial env vars entirely', () => withEnv(
    { TRUST_PROFILE_SWEEP_TRIAL_LIMIT: '1' },
    async () => {
      let captured = null;
      await main({
        deps: {
          enabled: true,
          listOrganisationIds: async () => ['ORG-X', 'ORG-Y', 'ORG-Z'],
          runScheduledSweep: async (args) => { captured = await args.deps.listOrganisationIds(); return { processed: [], skipped: [], failed: [] }; },
          recordCompletedRun: async () => {},
          now: () => '2026-07-13T00:00:00.000Z',
        },
      });
      assert.deepStrictEqual(captured, ['ORG-X', 'ORG-Y', 'ORG-Z']);
    },
  ));

  test('a non-positive TRUST_PROFILE_SWEEP_TRIAL_LIMIT is recorded as a crashed run, not a silent full-population fallback', () => withEnv(
    { TRUST_PROFILE_SWEEP_TRIAL_LIMIT: '0' },
    async () => {
      let captured = null;
      await assert.rejects(
        main({
          deps: {
            enabled: true,
            recordCrashedRun: async (args) => { captured = args; },
            now: () => '2026-07-13T00:00:00.000Z',
          },
        }),
        /TRUST_PROFILE_SWEEP_TRIAL_LIMIT must be a positive integer/,
      );
      assert.ok(captured);
    },
  ));
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
