'use strict';

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runScheduledSweep, SweepMalformedConfigError, effectiveThresholdMs, hashUnitInterval } = require('./scheduled-regeneration');

const MODULE_PATH = path.join(__dirname, 'scheduled-regeneration.js');

describe('CT-1 / TI-P-6 structural guardrail', () => {
  test('never references Collection Run / Session / on-demand pipeline code', () => {
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.ok(!/observatory\/collection/.test(src));
    assert.ok(!/runResilientCollectionSession/.test(src));
    assert.ok(!/on-demand-observation/.test(src));
  });
});

const SILENT_LOGGER = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function mockDeps(overrides = {}) {
  return {
    listOrganisationIds: async () => ['ORG-1', 'ORG-2'],
    getCurrent: async () => ({ exists: false }),
    generateTrustProfile: async (id, { trigger, generatedAt }) => ({ organisationId: id, trigger, generatedAt }),
    save: async () => {},
    now: () => '2026-07-13T00:00:00.000Z',
    logger: SILENT_LOGGER,
    ...overrides,
  };
}

describe('classification (CT-3, CT-4, CT-9)', () => {
  test('CT-3: "none generated yet" is always stale, regardless of threshold', async () => {
    const result = await runScheduledSweep({ policyThresholdMs: 1, deps: mockDeps({ listOrganisationIds: async () => ['ORG-1'] }) });
    assert.strictEqual(result.processed.length, 1);
  });

  test('CT-4/CT-9: an Organisation within the threshold is current, not regenerated', async () => {
    const deps = mockDeps({
      listOrganisationIds: async () => ['ORG-1'],
      getCurrent: async () => ({ exists: true, generatedAt: '2026-07-12T23:59:00.000Z' }), // 60s ago
      now: () => '2026-07-13T00:00:00.000Z',
    });
    const result = await runScheduledSweep({ policyThresholdMs: 3600 * 1000, deps });
    assert.strictEqual(result.processed.length, 0);
  });

  test('an Organisation older than the threshold is stale', async () => {
    const deps = mockDeps({
      listOrganisationIds: async () => ['ORG-1'],
      getCurrent: async () => ({ exists: true, generatedAt: '2026-07-01T00:00:00.000Z' }),
      now: () => '2026-07-13T00:00:00.000Z',
    });
    const result = await runScheduledSweep({ policyThresholdMs: 3600 * 1000, deps });
    assert.strictEqual(result.processed.length, 1);
  });
});

describe('CT-5 generatedAt uniqueness per Organisation call', () => {
  test('each stale Organisation gets its own freshly-stamped generatedAt with trigger: scheduled', async () => {
    let counter = 0;
    const deps = mockDeps({
      now: () => `2026-07-13T00:00:0${counter++}.000Z`,
    });
    const seen = [];
    deps.generateTrustProfile = async (id, opts) => { seen.push(opts); return { organisationId: id, ...opts }; };
    await runScheduledSweep({ policyThresholdMs: 1, deps });
    assert.strictEqual(seen.length, 2);
    assert.notStrictEqual(seen[0].generatedAt, seen[1].generatedAt);
    assert.ok(seen.every((s) => s.trigger === 'scheduled'));
  });
});

describe('§5 failure isolation (CT-6, CT-7)', () => {
  test('CT-6: a per-Organisation malformed current-resolution read is skipped, others unaffected', async () => {
    const deps = mockDeps({
      listOrganisationIds: async () => ['ORG-1', 'ORG-2'],
      getCurrent: async (id) => (id === 'ORG-1' ? { exists: 'not-a-boolean' } : { exists: false }),
    });
    const result = await runScheduledSweep({ policyThresholdMs: 1, deps });
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.skipped[0].organisationId, 'ORG-1');
    assert.strictEqual(result.processed.length, 1);
    assert.strictEqual(result.processed[0].organisationId, 'ORG-2');
  });

  test('CT-7: a generation failure for one Organisation does not affect another', async () => {
    const deps = mockDeps({
      generateTrustProfile: async (id) => {
        if (id === 'ORG-1') throw new Error('boom');
        return { organisationId: id };
      },
    });
    const result = await runScheduledSweep({ policyThresholdMs: 1, deps });
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].organisationId, 'ORG-1');
    assert.strictEqual(result.processed.length, 1);
    assert.strictEqual(result.processed[0].organisationId, 'ORG-2');
  });
});

describe('CT-8 malformed configuration halts the whole sweep', () => {
  test('a non-positive policyThresholdMs throws before any Organisation is processed', async () => {
    const deps = mockDeps();
    let called = false;
    deps.listOrganisationIds = async () => { called = true; return ['ORG-1']; };
    await assert.rejects(runScheduledSweep({ policyThresholdMs: 0, deps }), SweepMalformedConfigError);
    assert.strictEqual(called, false);
  });
});

describe('§9 idempotency (CT-2)', () => {
  test('running the sweep twice in succession does not regenerate an Organisation the first sweep just refreshed', async () => {
    let currentGeneratedAt = null;
    const deps = mockDeps({
      listOrganisationIds: async () => ['ORG-1'],
      getCurrent: async () => (currentGeneratedAt ? { exists: true, generatedAt: currentGeneratedAt } : { exists: false }),
      save: async (instance) => { currentGeneratedAt = instance.generatedAt; },
      now: () => '2026-07-13T00:00:00.000Z',
    });
    const first = await runScheduledSweep({ policyThresholdMs: 3600 * 1000, deps });
    assert.strictEqual(first.processed.length, 1);
    const second = await runScheduledSweep({ policyThresholdMs: 3600 * 1000, deps });
    assert.strictEqual(second.processed.length, 0);
  });
});

describe('deterministic staleness spreading (pre-production validation phase, 2026-07-16)', () => {
  test('the same organisationId always yields the same effective threshold', () => {
    const a = effectiveThresholdMs('ORG-CONSISTENCY-CHECK', 7 * 24 * 60 * 60 * 1000);
    const b = effectiveThresholdMs('ORG-CONSISTENCY-CHECK', 7 * 24 * 60 * 60 * 1000);
    assert.strictEqual(a, b);
  });

  test('effective threshold is always within [0.5x, 1.0x] of the configured policy threshold', () => {
    const policyThresholdMs = 7 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 200; i += 1) {
      const t = effectiveThresholdMs(`ORG-${i}`, policyThresholdMs);
      assert.ok(t >= policyThresholdMs * 0.5, `ORG-${i} threshold ${t} below floor`);
      assert.ok(t <= policyThresholdMs, `ORG-${i} threshold ${t} above configured policy`);
    }
  });

  test('distinct organisationIds spread across the window rather than clustering at one value', () => {
    const policyThresholdMs = 7 * 24 * 60 * 60 * 1000;
    const values = Array.from({ length: 200 }, (_, i) => effectiveThresholdMs(`ORG-${i}`, policyThresholdMs));
    const distinctBuckets = new Set(values.map((v) => Math.floor((v / policyThresholdMs) * 10)));
    assert.ok(distinctBuckets.size >= 3, `expected spread across multiple buckets, got ${distinctBuckets.size}`);
  });

  test('a population sharing one generatedAt (the first-ever sweep) desynchronizes on the next sweep instead of all going stale on the same day', async () => {
    const policyThresholdMs = 7 * 24 * 60 * 60 * 1000;
    const organisationIds = Array.from({ length: 50 }, (_, i) => `ORG-${i}`);
    const sharedGeneratedAt = '2026-07-01T00:00:00.000Z';
    const store = new Map(organisationIds.map((id) => [id, sharedGeneratedAt]));

    // 6 days after the shared generation — with a flat threshold, zero would
    // be stale yet; with spreading, some Organisations (effective threshold
    // below 6 days) are already due.
    const deps = mockDeps({
      listOrganisationIds: async () => organisationIds,
      getCurrent: async (id) => ({ exists: true, generatedAt: store.get(id) }),
      generateTrustProfile: async (id, { generatedAt }) => { store.set(id, generatedAt); return { organisationId: id }; },
      save: async () => {},
      now: () => '2026-07-07T00:00:00.000Z', // +6 days
    });
    const result = await runScheduledSweep({ policyThresholdMs, deps });
    assert.ok(result.processed.length > 0, 'expected at least one Organisation to have desynchronized ahead of the full 7-day mark');
    assert.ok(result.processed.length < organisationIds.length, 'expected the population to desynchronize, not regenerate all at once');
  });
});

describe('CT-11 determinism', () => {
  test('given the same population/reads/threshold/now, two sweeps classify identically', async () => {
    const a = await runScheduledSweep({ policyThresholdMs: 1, deps: mockDeps() });
    const b = await runScheduledSweep({ policyThresholdMs: 1, deps: mockDeps() });
    assert.deepStrictEqual(a.processed.map((p) => p.organisationId).sort(), b.processed.map((p) => p.organisationId).sort());
  });
});

describe('operational observability (Implementation Readiness Sprint, 2026-07-13)', () => {
  test('logs a start line (population size) and a completion summary (processed/skipped/failed counts)', async () => {
    const logs = { info: [], warn: [] };
    const logger = { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), error: () => {}, debug: () => {} };
    await runScheduledSweep({ policyThresholdMs: 1, deps: mockDeps({ logger }) });

    assert.ok(logs.info.some((m) => /starting/.test(m) && /2 Organisations/.test(m)), 'must log the population size at start');
    assert.ok(logs.info.some((m) => /complete/.test(m) && /2 processed/.test(m)), 'must log a completion summary');
  });

  test('logs a warning for every per-Organisation failure, without halting the sweep', async () => {
    const warnings = [];
    const logger = { info: () => {}, warn: (m) => warnings.push(m), error: () => {}, debug: () => {} };
    const deps = mockDeps({
      logger,
      generateTrustProfile: async (id) => { if (id === 'ORG-1') throw new Error('boom'); return { organisationId: id }; },
    });
    const result = await runScheduledSweep({ policyThresholdMs: 1, deps });
    assert.strictEqual(result.failed.length, 1);
    assert.ok(warnings.some((m) => m.includes('ORG-1') && m.includes('boom')));
  });

  test('logging is purely observational — omitting deps.logger does not change classification, only defaults to the real logger', async () => {
    const result = await runScheduledSweep({ policyThresholdMs: 1, deps: mockDeps({ logger: undefined }) });
    assert.strictEqual(result.processed.length, 2);
  });
});
