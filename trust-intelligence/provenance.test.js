'use strict';

// Conformance tests for the Provenance Builder (ENG-025 v1.1). Pure module,
// no I/O — every test supplies already-fetched mock inputs directly, per
// ENG-025 §1 ("performs no I/O of its own").

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildProvenance,
  ProvenanceMalformedInputError,
  ProvenanceVersionConflictError,
} = require('./provenance');

function signal(key, overrides = {}) {
  return {
    key,
    observed: true,
    qualityModelVersion: 'SPF-QM-v1.0',
    collectedAt: '2026-07-01T00:00:00.000Z',
    sourceRowRef: `row-${key}`,
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    organisationId: 'ORG-1',
    organisationDomains: ['example.com'],
    generatedAt: '2026-07-13T00:00:00.000Z',
    trigger: 'scheduled',
    signalsByDomain: { 'example.com': [signal('spf'), signal('dmarc', { observed: false })] },
    organisationHistoryRefs: ['obs-1', 'obs-2'],
    aggregationMethodVersion: 'TS-RUBRIC-v1.0',
    ...overrides,
  };
}

describe('construction — happy path', () => {
  test('CT-1 determinism: two calls with identical input produce byte-identical output', () => {
    const a = buildProvenance(baseInput());
    const b = buildProvenance(baseInput());
    assert.deepStrictEqual(a, b);
  });

  test('CT-2 idempotency: three calls in a row produce the same result, no shared state', () => {
    const input = baseInput();
    const r1 = buildProvenance(input);
    const r2 = buildProvenance(input);
    const r3 = buildProvenance(input);
    assert.deepStrictEqual(r1, r2);
    assert.deepStrictEqual(r2, r3);
  });

  test('CT-3 NON_OBSERVED omission: an unobserved signal produces no Vector or Manifest entry', () => {
    const { provenanceVector, provenanceManifest } = buildProvenance(baseInput());
    assert.ok(!('dmarc' in provenanceVector.qualityModelVersions));
    const domainEntry = provenanceManifest.domains.find((d) => d.domain === 'example.com');
    assert.ok(!domainEntry.signals.some((s) => s.key === 'dmarc'));
    assert.ok(domainEntry.signals.some((s) => s.key === 'spf'));
  });

  test('CT-4 honest empty domain: a domain with zero observed signals still appears, with signals: []', () => {
    const input = baseInput({
      organisationDomains: ['example.com', 'empty.example'],
      signalsByDomain: {
        'example.com': [signal('spf')],
        'empty.example': [signal('spf', { observed: false })],
      },
    });
    const { provenanceManifest } = buildProvenance(input);
    const empty = provenanceManifest.domains.find((d) => d.domain === 'empty.example');
    assert.deepStrictEqual(empty.signals, []);
  });

  test('CT-5 fixed ordering: signals within a domain are sorted ascending by key', () => {
    const input = baseInput({
      signalsByDomain: {
        'example.com': [signal('dmarc'), signal('caa'), signal('spf')],
      },
    });
    const { provenanceManifest } = buildProvenance(input);
    const keys = provenanceManifest.domains[0].signals.map((s) => s.key);
    assert.deepStrictEqual(keys, ['caa', 'dmarc', 'spf']);
  });

  test('CT-6 same-key-same-version across domains merges to one Vector entry', () => {
    const input = baseInput({
      organisationDomains: ['a.example', 'b.example'],
      signalsByDomain: {
        'a.example': [signal('spf', { qualityModelVersion: 'SPF-QM-v1.0' })],
        'b.example': [signal('spf', { qualityModelVersion: 'SPF-QM-v1.0' })],
      },
    });
    const { provenanceVector } = buildProvenance(input);
    assert.strictEqual(provenanceVector.qualityModelVersions.spf, 'SPF-QM-v1.0');
  });

  test('CT-9 Manifest embeds a byte-identical copy of the sibling provenanceVector', () => {
    const { provenanceVector, provenanceManifest } = buildProvenance(baseInput());
    assert.deepStrictEqual(provenanceManifest.provenanceVector, provenanceVector);
  });

  test('CT-10 Manifest signal versions match the Vector exactly', () => {
    const input = baseInput({
      signalsByDomain: { 'example.com': [signal('spf'), signal('dkim', { qualityModelVersion: 'DKIM-QM-v1.0' })] },
    });
    const { provenanceVector, provenanceManifest } = buildProvenance(input);
    for (const s of provenanceManifest.domains[0].signals) {
      assert.strictEqual(s.qualityModelVersion, provenanceVector.qualityModelVersions[s.key]);
    }
  });

  test('CT-11/CT-12 multi-domain: one Manifest entry per domain, no cross-domain signal bleed', () => {
    const input = baseInput({
      organisationDomains: ['a.example', 'b.example'],
      signalsByDomain: {
        'a.example': [signal('spf')],
        'b.example': [signal('dmarc')],
      },
    });
    const { provenanceManifest } = buildProvenance(input);
    assert.strictEqual(provenanceManifest.domains.length, 2);
    const a = provenanceManifest.domains.find((d) => d.domain === 'a.example');
    const b = provenanceManifest.domains.find((d) => d.domain === 'b.example');
    assert.deepStrictEqual(a.signals.map((s) => s.key), ['spf']);
    assert.deepStrictEqual(b.signals.map((s) => s.key), ['dmarc']);
  });

  test('organisationHistoryRefs preserved in caller-supplied order', () => {
    const { provenanceManifest } = buildProvenance(baseInput({ organisationHistoryRefs: ['obs-b', 'obs-a'] }));
    assert.deepStrictEqual(provenanceManifest.organisationHistoryRefs, ['obs-b', 'obs-a']);
  });

  test('provenanceManifest mirrors organisationId/generatedAt/trigger byte-identically', () => {
    const input = baseInput();
    const { provenanceManifest } = buildProvenance(input);
    assert.strictEqual(provenanceManifest.organisationId, input.organisationId);
    assert.strictEqual(provenanceManifest.generatedAt, input.generatedAt);
    assert.strictEqual(provenanceManifest.trigger, input.trigger);
  });
});

describe('CT-12/§8.1 integrity digest', () => {
  test('digest changes if any byte of the Manifest changes; stable otherwise', () => {
    const input = baseInput();
    const { provenanceManifest: m1 } = buildProvenance(input, { includeIntegrityDigest: true });
    const { provenanceManifest: m2 } = buildProvenance(input, { includeIntegrityDigest: true });
    assert.strictEqual(m1.integrityDigest, m2.integrityDigest);

    const altered = buildProvenance(baseInput({ organisationHistoryRefs: ['obs-1', 'obs-2', 'obs-3'] }), { includeIntegrityDigest: true });
    assert.notStrictEqual(altered.provenanceManifest.integrityDigest, m1.integrityDigest);
  });

  test('digest is absent when not requested', () => {
    const { provenanceManifest } = buildProvenance(baseInput());
    assert.strictEqual(provenanceManifest.integrityDigest, undefined);
  });
});

describe('CT-7 / V-D version-conflict failure', () => {
  test('same key, different versions across domains → version-conflict failure, no output', () => {
    const input = baseInput({
      organisationDomains: ['a.example', 'b.example'],
      signalsByDomain: {
        'a.example': [signal('spf', { qualityModelVersion: 'SPF-QM-v1.0' })],
        'b.example': [signal('spf', { qualityModelVersion: 'SPF-QM-v2.0' })],
      },
    });
    assert.throws(() => buildProvenance(input), ProvenanceVersionConflictError);
  });
});

describe('CT-8 / V-A..V-G malformed-input failures', () => {
  test('V-A: duplicate organisationDomains entries', () => {
    assert.throws(
      () => buildProvenance(baseInput({ organisationDomains: ['example.com', 'example.com'] })),
      ProvenanceMalformedInputError,
    );
  });

  test('V-B: observed signal missing qualityModelVersion', () => {
    const input = baseInput({
      signalsByDomain: { 'example.com': [signal('spf', { qualityModelVersion: '' })] },
    });
    assert.throws(() => buildProvenance(input), ProvenanceMalformedInputError);
  });

  test('V-C: duplicate organisationHistoryRefs', () => {
    assert.throws(
      () => buildProvenance(baseInput({ organisationHistoryRefs: ['obs-1', 'obs-1'] })),
      ProvenanceMalformedInputError,
    );
  });

  test('V-E: empty aggregationMethodVersion', () => {
    assert.throws(
      () => buildProvenance(baseInput({ aggregationMethodVersion: '' })),
      ProvenanceMalformedInputError,
    );
  });

  test('V-F: signalsByDomain missing an entry for a declared domain', () => {
    const input = baseInput({ organisationDomains: ['example.com', 'missing.example'] });
    assert.throws(() => buildProvenance(input), ProvenanceMalformedInputError);
  });

  test('V-F: signalsByDomain has an extra domain not in organisationDomains', () => {
    const input = baseInput({
      signalsByDomain: { 'example.com': [signal('spf')], 'extra.example': [signal('spf')] },
    });
    assert.throws(() => buildProvenance(input), ProvenanceMalformedInputError);
  });

  test('V-G: duplicate observed signal key within one domain', () => {
    const input = baseInput({
      signalsByDomain: { 'example.com': [signal('spf'), signal('spf')] },
    });
    assert.throws(() => buildProvenance(input), ProvenanceMalformedInputError);
  });

  test('a construction failure never returns a partial result', () => {
    const input = baseInput({ aggregationMethodVersion: '' });
    let threw = false;
    try {
      buildProvenance(input);
    } catch (e) {
      threw = true;
      assert.ok(e instanceof ProvenanceMalformedInputError);
    }
    assert.ok(threw);
  });
});

describe('§10 output guarantees / purity', () => {
  test('does not mutate its inputs', () => {
    const input = baseInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    buildProvenance(input);
    assert.deepStrictEqual(input, snapshot);
  });
});
