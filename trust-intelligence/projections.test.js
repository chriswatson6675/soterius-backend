'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { publicProjection, authenticatedProjection } = require('./projections');

function instance(overrides = {}) {
  return {
    organisationId: 'ORG-1',
    organisationDomains: ['example.com'],
    generatedAt: '2026-07-13T00:00:00.000Z',
    trigger: 'scheduled',
    provenanceVector: { aggregationMethodVersion: 'TS-RUBRIC-v1.0', qualityModelVersions: { spf: 'SPF-QM-v1.0' } },
    provenanceManifest: { organisationId: 'ORG-1', generatedAt: '2026-07-13T00:00:00.000Z', trigger: 'scheduled', provenanceVector: {}, domains: [], organisationHistoryRefs: [] },
    trustScore: { value: 750, band: 'Good', earned: 700, attainable: 900, completeness: 0.9, coreComplete: false, observedSignalCount: 1 },
    componentBreakdown: [{ id: 'spf', category: 'A', weight: 900, observed: true, earned: 700 }],
    categoryScores: { A: { earned: 700, attainable: 900 } },
    ...overrides,
  };
}

describe('CT-5 Public Projection', () => {
  test('contains no provenance, manifest, categoryScores, or organisationDomains key', () => {
    const p = publicProjection(instance());
    assert.strictEqual(p.provenanceVector, undefined);
    assert.strictEqual(p.provenanceManifest, undefined);
    assert.strictEqual(p.categoryScores, undefined);
    assert.strictEqual(p.organisationDomains, undefined);
  });

  test('signalFlags carries id/observed only, never score/weight/earned', () => {
    const p = publicProjection(instance());
    assert.deepStrictEqual(p.signalFlags, [{ id: 'spf', observed: true }]);
  });

  test('band is absent when value is INSUFFICIENT_OBSERVATION', () => {
    const p = publicProjection(instance({ trustScore: { value: 'INSUFFICIENT_OBSERVATION', earned: 0, attainable: 0, completeness: 0, coreComplete: false, observedSignalCount: 0 } }));
    assert.strictEqual(p.band, undefined);
    assert.strictEqual(p.headlineScore, 'INSUFFICIENT_OBSERVATION');
  });
});

describe('CT-6 Authenticated Projection', () => {
  test('carries the full instance verbatim with no benchmarkOverlay when none is supplied', () => {
    const inst = instance();
    const p = authenticatedProjection(inst);
    assert.deepStrictEqual({ ...p, benchmarkOverlay: undefined }, { ...inst, benchmarkOverlay: undefined });
    assert.strictEqual(p.benchmarkOverlay, undefined);
  });

  test('a supplied overlay always carries live: true and never overlaps a base instance key', () => {
    const p = authenticatedProjection(instance(), { percentile: 72 });
    assert.strictEqual(p.benchmarkOverlay.live, true);
    assert.strictEqual(p.benchmarkOverlay.percentile, 72);
    const baseKeys = new Set(Object.keys(instance()));
    assert.ok(!Object.keys(p.benchmarkOverlay).some((k) => k !== 'live' && k !== 'percentile' && baseKeys.has(k)));
  });
});

describe('I-6 Public is always a strict subset of Authenticated', () => {
  test('every Public field value matches the corresponding Authenticated field', () => {
    const inst = instance();
    const pub = publicProjection(inst);
    const auth = authenticatedProjection(inst);
    assert.strictEqual(pub.headlineScore, auth.trustScore.value);
    assert.strictEqual(pub.band, auth.trustScore.band);
  });
});
