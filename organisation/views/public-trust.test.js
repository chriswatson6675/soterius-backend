'use strict';

// public-trust.test.js — the redacted Public Trust view (ENG-008 §9). Proves
// this view strictly reduces the canonical Organisation object; it never adds,
// invents, or independently computes a value the full object doesn't already
// carry (grade is derived via the SAME letterGrade() the authenticated
// observatory adapter uses — not a re-implemented threshold ladder).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { publicTrustView } = require('./public-trust');

function organisation(overrides = {}) {
  return {
    id: 'ORG-ABCDEF012345',
    displayName: 'Example Ltd',
    domains: [{ domain: 'example.com', role: 'primary' }],
    identifiers: [{ scheme: 'companies-house', value: '00000001' }],
    legalEntities: [{ name: 'Example Ltd' }],
    regulators: [],
    classification: [],
    people: [],
    history: [{ event: 'incorporated' }],
    provenance: [{ section: 'digitalTrust', source: 'soterius-observatory' }],
    metadata: { sourcesConsulted: ['soterius-observatory'] },
    lifecycle: { status: 'active' },
    digitalTrust: null,
    ...overrides,
  };
}

describe('publicTrustView', () => {
  test('digitalTrust null (Unknown, not fabricated) passes through as null, never a default score', () => {
    const view = publicTrustView(organisation({ digitalTrust: null }));
    assert.equal(view.digitalTrust, null);
  });

  test('keeps id, domain, displayName, and the digitalTrust headline', () => {
    const view = publicTrustView(organisation({
      digitalTrust: { overallScore: 71, grade: 'B', signalsObserved: 8, signalsTotal: 10, categories: [] },
    }));
    assert.equal(view.id, 'ORG-ABCDEF012345');
    assert.equal(view.domain, 'example.com');
    assert.equal(view.displayName, 'Example Ltd');
    assert.equal(view.digitalTrust.overallScore, 71);
    assert.equal(view.digitalTrust.grade, 'B');
    assert.equal(view.digitalTrust.signalsObserved, 8);
    assert.equal(view.digitalTrust.signalsTotal, 10);
  });

  test('reduces each category to {category, grade} only — never the raw per-signal array or averageScore', () => {
    const view = publicTrustView(organisation({
      digitalTrust: {
        overallScore: 60, grade: 'C', signalsObserved: 2, signalsTotal: 2,
        categories: [
          { category: 'A', averageScore: 95, signals: [{ key: 'spf', score: 95, collectedAt: 'T' }] },
          { category: 'H', averageScore: 20, signals: [{ key: 'disclosure', score: 20, collectedAt: 'T' }] },
        ],
      },
    }));
    assert.deepEqual(view.digitalTrust.categories, [
      { category: 'A', grade: 'A' },
      { category: 'H', grade: 'E' },
    ]);
    assert.equal(view.digitalTrust.categories[0].signals, undefined);
    assert.equal(view.digitalTrust.categories[0].averageScore, undefined);
  });

  test('never exposes history, provenance, identifiers, legalEntities, regulators, people, classification, metadata, or lifecycle', () => {
    const view = publicTrustView(organisation());
    for (const field of ['history', 'provenance', 'identifiers', 'legalEntities', 'regulators', 'people', 'classification', 'metadata', 'lifecycle']) {
      assert.equal(view[field], undefined, `expected "${field}" to be redacted`);
    }
  });

  test('tolerates a minimal/ephemeral organisation with no domains array (NOT_FOUND discovery path) without throwing', () => {
    const view = publicTrustView({ id: 'ORG-EPHEMERAL01', displayName: null, digitalTrust: null });
    assert.equal(view.domain, null);
    assert.equal(view.digitalTrust, null);
  });
});
