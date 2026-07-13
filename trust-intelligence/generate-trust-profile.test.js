'use strict';

// Conformance tests for the Canonical Trust Profile Builder (ENG-029 v1.1,
// ENG-014 WP-4). IT-1/IT-2 (ENG-014 §4) are written and run BEFORE the
// generation body per R-7's own recommendation ("this test exists before
// WP-4's generation logic is written, not after, so it functions as a
// guardrail rather than a retrospective check").

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const MODULE_PATH = path.join(__dirname, 'generate-trust-profile.js');

describe('IT-1/IT-2 — structural guardrails (source-text checks, mirrors *.structural.test.js convention)', () => {
  test('IT-1: never references a signal_facts_* table or a raw Observation read', () => {
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.ok(!/signal_facts_/.test(src), 'must not reference signal_facts_* directly');
    assert.ok(!/from\(['"`]?signal_/.test(src) || /getSignalsForDomain/.test(src), 'any signal_* reference must be through getSignalsForDomain');
  });

  test('IT-1/TI-P-6: never requires collection/session/on-demand modules', () => {
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.ok(!/observatory\/collection/.test(src), 'must not require observatory/collection/*');
    assert.ok(!/runResilientCollectionSession/.test(src), 'must not call runResilientCollectionSession');
    assert.ok(!/on-demand-observation/.test(src), 'must not require the on-demand pipeline (WP-4 is decoupled from triggers)');
  });

  test('IT-2: contains no per-signal scoring formula of its own (no hand-rolled weight/earn arithmetic)', () => {
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    // A per-signal score re-implementation would look like arithmetic against
    // a signal's raw score/weight — this module must only ever restate
    // scoreTrust()'s own already-computed fields, never recompute earned/
    // attainable itself.
    assert.ok(!/\.score\s*\/\s*100/.test(src), 'must not recompute a normalised score fraction itself (that is TS-RUBRIC/the Aggregator\'s job)');
    assert.ok(!/WEIGHTS\s*=/.test(src), 'must not declare its own weights table');
  });
});

const { generateTrustProfile, TrustProfileMalformedInputError, ProvenanceConstructionError, TrustScoreEngineError } = require('./generate-trust-profile');

function mockDeps(overrides = {}) {
  const org = {
    ok: true,
    organisation: { id: 'ORG-1', domains: [{ domain: 'example.com', role: 'primary' }] },
  };
  const signals = [
    { key: 'spf', category: 'A', observed: true, score: 90, qualityVersion: '1.0', collectedAt: '2026-07-01T00:00:00.000Z', rowId: 'row-spf' },
    { key: 'dmarc', category: 'A', observed: false },
  ];
  const history = {
    organisationId: 'ORG-1',
    entries: [{ observationId: 'obs-1', collectedAt: '2026-07-01T00:00:00.000Z' }],
  };
  const scoreResult = {
    score: 750,
    label: 'SCORED',
    band: 'Good',
    earned: 700,
    attainable: 900,
    completeness: 0.9,
    coreComplete: false,
    observedSignalCount: 1,
    categories: { A: { earned: 700, attainable: 900 } },
    signals: [{ id: 'spf', category: 'A', weight: 900, observed: true, earned: 700 }],
  };

  return {
    assembleById: async () => org,
    getSignalsForDomain: async () => signals,
    buildOrganisationHistory: async () => history,
    scoreTrust: async () => scoreResult,
    RUBRIC: 'TS-RUBRIC-v1.0',
    ...overrides,
  };
}

describe('assembly — happy path', () => {
  test('assembles all nine ENG-023 §6 fields', async () => {
    const result = await generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps: mockDeps() });
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, [
      'categoryScores', 'componentBreakdown', 'generatedAt', 'organisationDomains',
      'organisationId', 'provenanceManifest', 'provenanceVector', 'trigger', 'trustScore',
    ].sort());
  });

  test('CT-3 ENG-023 V-11: Manifest mirrors are byte-identical to the outer instance', async () => {
    const result = await generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps: mockDeps() });
    assert.strictEqual(result.provenanceManifest.organisationId, result.organisationId);
    assert.strictEqual(result.provenanceManifest.generatedAt, result.generatedAt);
    assert.strictEqual(result.provenanceManifest.trigger, result.trigger);
    assert.deepStrictEqual(result.provenanceManifest.provenanceVector, result.provenanceVector);
  });

  test('CT-7 componentBreakdown/categoryScores are verbatim pass-throughs of scoreTrust()', async () => {
    const result = await generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps: mockDeps() });
    assert.deepStrictEqual(result.componentBreakdown, [{ id: 'spf', category: 'A', weight: 900, observed: true, earned: 700 }]);
    assert.deepStrictEqual(result.categoryScores, { A: { earned: 700, attainable: 900 } });
  });

  test('CT-4 INSUFFICIENT_OBSERVATION is a valid instance, never a failure', async () => {
    const deps = mockDeps({
      scoreTrust: async () => ({
        score: 'INSUFFICIENT_OBSERVATION', label: 'INSUFFICIENT_OBSERVATION', earned: 0, attainable: 0,
        completeness: 0, coreComplete: false, observedSignalCount: 0, categories: {}, signals: [],
      }),
    });
    const result = await generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps });
    assert.strictEqual(result.trustScore.value, 'INSUFFICIENT_OBSERVATION');
    assert.strictEqual(result.trustScore.band, undefined);
  });

  test('CT-10 no tenth field is ever present', async () => {
    const result = await generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps: mockDeps() });
    assert.strictEqual(Object.keys(result).length, 9);
  });

  test('zero-domain Organisation: no scoreTrust() call, honest INSUFFICIENT_OBSERVATION instance', async () => {
    const deps = mockDeps({
      assembleById: async () => ({ ok: true, organisation: { id: 'ORG-2', domains: [] } }),
      scoreTrust: async () => { throw new Error('scoreTrust must not be called with zero domains'); },
    });
    const result = await generateTrustProfile('ORG-2', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps });
    assert.deepStrictEqual(result.organisationDomains, []);
    assert.strictEqual(result.trustScore.value, 'INSUFFICIENT_OBSERVATION');
    assert.deepStrictEqual(result.componentBreakdown, []);
    assert.deepStrictEqual(result.categoryScores, {});
  });
});

describe('§7 failure handling', () => {
  test('CT-6 a mocked Trust Score engine throw is a distinguishable failure, no partial instance', async () => {
    const deps = mockDeps({ scoreTrust: async () => { throw new Error('boom'); } });
    await assert.rejects(
      generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps }),
      TrustScoreEngineError,
    );
  });

  test('CT-5 a provenance-construction failure (version conflict) is distinguishable, no partial instance', async () => {
    const deps = mockDeps();
    // Force a version conflict by supplying two domains with divergent versions.
    deps.assembleById = async () => ({ ok: true, organisation: { id: 'ORG-1', domains: [{ domain: 'a.example' }, { domain: 'b.example' }] } });
    let call = 0;
    deps.getSignalsForDomain = async () => {
      call += 1;
      return [{ key: 'spf', observed: true, score: 90, qualityVersion: call === 1 ? '1.0' : '2.0', collectedAt: '2026-07-01T00:00:00.000Z', rowId: `row-${call}` }];
    };
    await assert.rejects(
      generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps }),
      ProvenanceConstructionError,
    );
  });

  test('B-2 malformed trigger value is rejected', async () => {
    await assert.rejects(
      generateTrustProfile('ORG-1', { trigger: 'exception-resolved', generatedAt: '2026-07-13T00:00:00.000Z', deps: mockDeps() }),
      TrustProfileMalformedInputError,
    );
  });
});

describe('BUG-1 regression — default client for the real Organisation History read', () => {
  // Found while running the Trust Intelligence Validation Sprint (2026-07-13)
  // against live SRA/FCA/HE populations: every real caller of
  // generateTrustProfile() (runScheduledSweep, runOnDemandRegeneration, the
  // GET /:id?generate=true API route) leaves deps.client unset, relying on
  // this module to default it the same way it already defaults assembleById/
  // getSignalsForDomain/scoreTrust. It did not — buildOrganisationHistory's
  // own required-client check threw "a database client is required" for
  // every single Organisation, in every real code path, with 0 unit test
  // ever catching it (every existing test above injects its own
  // buildOrganisationHistory mock, which never needed a client at all).
  test('when buildOrganisationHistory is NOT overridden, a real client is supplied instead of undefined', async () => {
    const database = require('../infra/database');
    const originalGetClient = database.getClient;
    let capturedTable = null;
    const fakeClient = {
      from(table) {
        capturedTable = table;
        return {
          select: () => ({
            eq: async () => ({ data: [], error: null }),
          }),
        };
      },
    };
    database.getClient = () => fakeClient;

    try {
      const deps = mockDeps();
      delete deps.buildOrganisationHistory; // force the real implementation to run
      const result = await generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps });
      assert.strictEqual(result.organisationId, 'ORG-1');
      assert.ok(capturedTable, 'the real buildOrganisationHistory must have been called with a working client, not thrown "a database client is required"');
    } finally {
      database.getClient = originalGetClient;
    }
  });

  test('an explicitly injected buildOrganisationHistory is never forced into a real DB connection', async () => {
    const database = require('../infra/database');
    const originalGetClient = database.getClient;
    let getClientCalled = false;
    database.getClient = () => { getClientCalled = true; throw new Error('must not be called'); };

    try {
      await generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps: mockDeps() });
      assert.strictEqual(getClientCalled, false, 'a mocked buildOrganisationHistory must not trigger a real getClient() call');
    } finally {
      database.getClient = originalGetClient;
    }
  });
});

describe('§8/§9 determinism and idempotency', () => {
  test('two calls with identical mocked inputs produce byte-identical output', async () => {
    const a = await generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps: mockDeps() });
    const b = await generateTrustProfile('ORG-1', { trigger: 'scheduled', generatedAt: '2026-07-13T00:00:00.000Z', deps: mockDeps() });
    assert.deepStrictEqual(a, b);
  });
});
