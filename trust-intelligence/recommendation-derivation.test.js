'use strict';

// recommendation-derivation.test.js — ADR-SYS-012 (RD-1…RD-8) compliance,
// exercised directly against the pure function (no DB, no server).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { deriveRecommendations, DERIVATION_VERSION } = require('./recommendation-derivation');

function signal(key, overrides = {}) {
  return {
    key,
    qualityModelVersion: `${key.toUpperCase()}-QM-v1.0`,
    collectedAt: '2026-07-01T00:00:00.000Z',
    sourceRowRef: `row-${key}`,
    ...overrides,
  };
}

function instance(componentBreakdown, signals = [], overrides = {}) {
  return {
    organisationId: 'ORG-1',
    organisationDomains: ['example.com'],
    generatedAt: '2026-07-13T00:00:00.000Z',
    trigger: 'scheduled',
    provenanceVector: { aggregationMethodVersion: '1.0', qualityModelVersions: {} },
    provenanceManifest: {
      organisationId: 'ORG-1',
      generatedAt: '2026-07-13T00:00:00.000Z',
      trigger: 'scheduled',
      domains: [{ domain: 'example.com', signals }],
      organisationHistoryRefs: [],
    },
    trustScore: { value: 500, band: 'Moderate Risk', earned: 500, attainable: 999, completeness: 0.5, coreComplete: false, observedSignalCount: componentBreakdown.length },
    componentBreakdown,
    categoryScores: {},
    ...overrides,
  };
}

describe('RD-1 — derives only from the Trust Profile Instance', () => {
  test('a fully-satisfied observed component (earned === weight) produces no recommendation', () => {
    const result = deriveRecommendations(instance(
      [{ id: 'spf', category: 'A', weight: 100, observed: true, earned: 100 }],
      [signal('spf')],
    ));
    assert.strictEqual(result.recommendations.length, 0);
  });

  test('an observed component with a real shortfall (earned < weight) produces exactly one recommendation', () => {
    const result = deriveRecommendations(instance(
      [{ id: 'spf', category: 'A', weight: 100, observed: true, earned: 20 }],
      [signal('spf')],
    ));
    assert.strictEqual(result.recommendations.length, 1);
    assert.strictEqual(result.recommendations[0].componentId, 'spf');
    assert.strictEqual(result.recommendations[0].status, 'gap');
  });

  test('never reads any field outside componentBreakdown/provenanceManifest — extra instance fields are ignored, not leaked', () => {
    const inst = instance([{ id: 'spf', category: 'A', weight: 100, observed: true, earned: 20 }], [signal('spf')]);
    inst.secretField = 'should never appear anywhere in the output';
    const result = deriveRecommendations(inst);
    assert.ok(!JSON.stringify(result).includes('secretField'));
  });
});

describe('RD-5 — Unknown must never generate a misleading recommendation', () => {
  test('observed: false produces no recommendation at all, regardless of earned/weight', () => {
    const result = deriveRecommendations(instance(
      [{ id: 'dmarc', category: 'A', weight: 154, observed: false, earned: 0 }],
      [],
    ));
    assert.strictEqual(result.recommendations.length, 0);
  });
});

describe('RD-2 — explainable through provenance', () => {
  test('every recommendation carries the exact provenance record for its signal', () => {
    const result = deriveRecommendations(instance(
      [{ id: 'dmarc', category: 'A', weight: 154, observed: true, earned: 20 }],
      [signal('dmarc', { collectedAt: '2026-07-10T00:00:00.000Z', sourceRowRef: 'row-999' })],
    ));
    assert.deepStrictEqual(result.recommendations[0].provenance, {
      signalKey: 'dmarc',
      qualityModelVersion: 'DMARC-QM-v1.0',
      collectedAt: '2026-07-10T00:00:00.000Z',
      sourceRowRef: 'row-999',
    });
  });

  test('an observed component with a shortfall but no matching provenance signal is skipped, never presented with fabricated provenance', () => {
    const result = deriveRecommendations(instance(
      [{ id: 'dmarc', category: 'A', weight: 154, observed: true, earned: 20 }],
      [], // no matching signal in provenanceManifest
    ));
    assert.strictEqual(result.recommendations.length, 0);
  });

  test('searches every domain, not just the first', () => {
    const inst = instance(
      [{ id: 'spf', category: 'A', weight: 100, observed: true, earned: 10 }],
      [],
    );
    inst.provenanceManifest.domains = [
      { domain: 'other.com', signals: [] },
      { domain: 'example.com', signals: [signal('spf')] },
    ];
    const result = deriveRecommendations(inst);
    assert.strictEqual(result.recommendations.length, 1);
    assert.strictEqual(result.recommendations[0].provenance.signalKey, 'spf');
  });
});

describe('RD-3 — no second evidence pipeline / no re-scoring', () => {
  test('severity and priority are computed only from earned/weight, never from category or an external input', () => {
    const result = deriveRecommendations(instance(
      [{ id: 'spf', category: 'A', weight: 100, observed: true, earned: 25 }], // gapRatio 0.75 -> Critical
      [signal('spf')],
    ));
    assert.strictEqual(result.recommendations[0].gapPoints, 75);
    assert.strictEqual(result.recommendations[0].gapRatio, 0.75);
    assert.strictEqual(result.recommendations[0].severity, 'Critical');
  });

  test('severity band boundaries — exact quartile cutoffs', () => {
    const cases = [
      { earned: 25, weight: 100, expected: 'Critical' }, // gapRatio 0.75
      { earned: 26, weight: 100, expected: 'High' },      // gapRatio 0.74
      { earned: 50, weight: 100, expected: 'High' },      // gapRatio 0.50
      { earned: 51, weight: 100, expected: 'Moderate' },  // gapRatio 0.49
      { earned: 75, weight: 100, expected: 'Moderate' },  // gapRatio 0.25
      { earned: 76, weight: 100, expected: 'Low' },       // gapRatio 0.24
      { earned: 99, weight: 100, expected: 'Low' },       // gapRatio 0.01
    ];
    for (const c of cases) {
      const result = deriveRecommendations(instance(
        [{ id: 'spf', category: 'A', weight: c.weight, observed: true, earned: c.earned }],
        [signal('spf')],
      ));
      assert.strictEqual(result.recommendations[0].severity, c.expected, `earned=${c.earned}/weight=${c.weight}`);
    }
  });
});

describe('RD-4 — identity-consistent with the canonical Organisation', () => {
  test('organisationId and trustProfileGeneratedAt are carried through unchanged, never re-resolved', () => {
    const result = deriveRecommendations(instance(
      [{ id: 'spf', category: 'A', weight: 100, observed: true, earned: 20 }],
      [signal('spf')],
      { organisationId: 'ORG-ABC123', generatedAt: '2026-06-01T00:00:00.000Z' },
    ));
    assert.strictEqual(result.organisationId, 'ORG-ABC123');
    assert.strictEqual(result.trustProfileGeneratedAt, '2026-06-01T00:00:00.000Z');
  });
});

describe('RD-7 — deterministic, reproducible, strict priority ordering', () => {
  test('identical input always produces identical output', () => {
    const inst = instance(
      [
        { id: 'spf', category: 'A', weight: 100, observed: true, earned: 20 },
        { id: 'dmarc', category: 'A', weight: 154, observed: true, earned: 50 },
      ],
      [signal('spf'), signal('dmarc')],
    );
    const first = deriveRecommendations(inst);
    const second = deriveRecommendations(inst);
    assert.deepStrictEqual(first, second);
  });

  test('priority ranks by descending gapPoints (points recoverable), not insertion order', () => {
    const result = deriveRecommendations(instance(
      [
        { id: 'spf', category: 'A', weight: 100, observed: true, earned: 90 },   // gapPoints 10
        { id: 'dmarc', category: 'A', weight: 154, observed: true, earned: 20 }, // gapPoints 134
      ],
      [signal('spf'), signal('dmarc')],
    ));
    assert.strictEqual(result.recommendations[0].componentId, 'dmarc');
    assert.strictEqual(result.recommendations[0].priority, 1);
    assert.strictEqual(result.recommendations[1].componentId, 'spf');
    assert.strictEqual(result.recommendations[1].priority, 2);
  });

  test('ties in gapPoints break by severity, then category, then componentId — never ambiguous', () => {
    const result = deriveRecommendations(instance(
      [
        { id: 'zzz', category: 'B', weight: 100, observed: true, earned: 50 }, // gapPoints 50
        { id: 'aaa', category: 'A', weight: 100, observed: true, earned: 50 }, // gapPoints 50, same severity+earlier category
      ],
      [signal('zzz'), signal('aaa')],
    ));
    assert.strictEqual(result.recommendations[0].componentId, 'aaa');
    assert.strictEqual(result.recommendations[1].componentId, 'zzz');
  });
});

describe('RD-8 — versioned', () => {
  test('every result is stamped with the current derivation version', () => {
    const result = deriveRecommendations(instance(
      [{ id: 'spf', category: 'A', weight: 100, observed: true, earned: 20 }],
      [signal('spf')],
    ));
    assert.strictEqual(result.derivationVersion, DERIVATION_VERSION);
    assert.strictEqual(result.derivationVersion, 'REC-DERIVE-v1.0');
  });
});

describe('empty/edge cases', () => {
  test('no componentBreakdown entries → empty recommendations, no crash', () => {
    const result = deriveRecommendations(instance([], []));
    assert.deepStrictEqual(result.recommendations, []);
  });

  test('a zero-weight component never divides by zero', () => {
    const result = deriveRecommendations(instance(
      [{ id: 'weird', category: 'A', weight: 0, observed: true, earned: 0 }],
      [signal('weird')],
    ));
    // earned (0) >= weight (0) — no gap, no recommendation, no NaN/Infinity anywhere.
    assert.strictEqual(result.recommendations.length, 0);
  });
});
