'use strict';

// Sprint 8 — shared Observation envelope builder. Locks the contract of the
// signal-agnostic envelope every collector will depend on.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildObservationEnvelope } = require('./observation-envelope');

const base = {
  run: { id: 'run-1', programme_id: 'prog-1' },
  collector: 'demo',
  collectorVersion: 'demo@1.0.0',
  collectionMethod: 'DoH:example',
  observedAt: '2026-01-01T00:00:00.000Z',
  collectionOutcome: 'OBSERVED_PRESENT',
};

describe('buildObservationEnvelope', () => {
  test('produces the full envelope, sourcing ownership from the run', () => {
    const e = buildObservationEnvelope(base);
    assert.equal(e.collection_run_id, 'run-1');
    assert.equal(e.collection_programme_id, 'prog-1');
    assert.equal(e.collector, 'demo');
    assert.equal(e.collector_version, 'demo@1.0.0');
    assert.equal(e.collection_method, 'DoH:example');
    assert.equal(e.collected_at, '2026-01-01T00:00:00.000Z');
    assert.equal(e.collection_outcome, 'OBSERVED_PRESENT');
  });

  test('organisation_id / repository_authority_ref default to null (contract P-5/OC-6)', () => {
    const e = buildObservationEnvelope(base);
    assert.equal(e.organisation_id, null);
    assert.equal(e.repository_authority_ref, null);
  });

  test('carries organisation reference through when supplied', () => {
    const e = buildObservationEnvelope({ ...base, organisationId: 'ORG-1', repositoryAuthorityRef: 'ra@t' });
    assert.equal(e.organisation_id, 'ORG-1');
    assert.equal(e.repository_authority_ref, 'ra@t');
  });

  test('carries no interpreted field — envelope is evidence-tier only', () => {
    const e = buildObservationEnvelope(base);
    for (const k of ['score', 'final_score', 'primary_label', 'risk_band', 'grade']) {
      assert.equal(k in e, false);
    }
  });

  test('rejects a missing/incomplete run, collector, or outcome', () => {
    assert.throws(() => buildObservationEnvelope({ ...base, run: undefined }), /Collection Run .* is required/);
    assert.throws(() => buildObservationEnvelope({ ...base, run: { id: 'r' } }), /programme_id/);
    assert.throws(() => buildObservationEnvelope({ ...base, collector: undefined }), /collector identity is required/);
    assert.throws(() => buildObservationEnvelope({ ...base, collectionOutcome: undefined }), /collectionOutcome is required/);
  });
});
