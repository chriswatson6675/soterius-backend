'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runOnDemandRegeneration, OnDemandTriggerError } = require('./on-demand-regeneration');

function mockDeps(overrides = {}) {
  return {
    runOnDemandObservation: async () => ({ ok: true, organisationId: 'ORG-1', sessionId: 'sess-1' }),
    generateTrustProfile: async (id, opts) => ({ organisationId: id, ...opts }),
    save: async () => {},
    now: () => '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('TI-P-6 sequencing', () => {
  test('generation is invoked only after the on-demand pipeline resolves, with trigger: on-demand', async () => {
    const order = [];
    const deps = mockDeps({
      runOnDemandObservation: async () => { order.push('observe'); return { ok: true, organisationId: 'ORG-1' }; },
      generateTrustProfile: async (id, opts) => { order.push('generate'); return { organisationId: id, ...opts }; },
    });
    const instance = await runOnDemandRegeneration('example.com', deps);
    assert.deepStrictEqual(order, ['observe', 'generate']);
    assert.strictEqual(instance.trigger, 'on-demand');
    assert.strictEqual(instance.organisationId, 'ORG-1');
  });

  test('a pipeline that does not settle (ok: false) never reaches generation', async () => {
    let generateCalled = false;
    const deps = mockDeps({
      runOnDemandObservation: async () => ({ ok: false, error: 'resolution failed' }),
      generateTrustProfile: async () => { generateCalled = true; },
    });
    await assert.rejects(runOnDemandRegeneration('example.com', deps), OnDemandTriggerError);
    assert.strictEqual(generateCalled, false);
  });

  test('the resulting instance is persisted via store.save', async () => {
    let saved = null;
    const deps = mockDeps({ save: async (instance) => { saved = instance; } });
    const instance = await runOnDemandRegeneration('example.com', deps);
    assert.deepStrictEqual(saved, instance);
  });
});
