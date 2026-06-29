'use strict';

// coverage.test.js — coverage + integrity-status unit tests (pure, over a model).

const { test } = require('node:test');
const assert = require('node:assert');
const { buildCoverage, integrityStatusOf } = require('./coverage');

const PROFILE = { sourceId: 'sra' };

function model(over = {}) {
  return {
    manifest: { runId: 'SNAP-1', segmentCount: 1, segments: [{ file: 'snapshot.json' }], snapshotProductionTimestamp: '2026-06-28T23:00:00Z', ...(over.manifest || {}) },
    rawIndex: over.rawIndex || [{ file: 'snapshot.json' }],
    rawIndexPresent: over.rawIndexPresent ?? true,
    structured: over.structured || { present: true, recordCount: 9, byObjectType: { 'sra.firm': 2 }, distinctAnchors: 2, unrecognised: [] },
    provenance: over.provenance || { present: true, lineageCount: 9 },
    sealed: over.sealed ?? true,
    artefacts: over.artefacts || { manifest: true, rawIndex: true, structured: true, provenance: true, sealed: true },
    integrity: 'integrity' in over ? over.integrity : { records: { total: 9, verified: 9, failures: [] }, rawHashes: { checked: 1, verified: 1 } },
  };
}

test('integrityStatusOf: verified, failed, and unverified', () => {
  assert.strictEqual(integrityStatusOf({ records: { total: 3, verified: 3 }, rawHashes: { checked: 1, verified: 1 } }).ok, true);
  assert.strictEqual(integrityStatusOf({ records: { total: 3, verified: 2 }, rawHashes: { checked: 1, verified: 1 } }).ok, false);
  assert.strictEqual(integrityStatusOf({ ok: true }).status, 'verified');
  assert.deepStrictEqual(integrityStatusOf(null), { status: 'unverified', ok: null, records: null, rawHashes: null });
});

test('coverageComplete true for a clean, sealed, consistent, verified package', () => {
  const c = buildCoverage(model(), PROFILE);
  assert.strictEqual(c.coverageComplete, true);
  assert.strictEqual(c.snapshot.segmentsConsistent, true);
  assert.strictEqual(c.package.complete, true);
  assert.strictEqual(c.integrity.status, 'verified');
  assert.strictEqual(c.structured.total, 9);
});

test('segment mismatch makes the snapshot inconsistent and coverage incomplete', () => {
  const c = buildCoverage(model({ rawIndex: [{ file: 'a' }, { file: 'b' }] }), PROFILE);
  assert.strictEqual(c.snapshot.segmentsConsistent, false);
  assert.strictEqual(c.coverageComplete, false);
});

test('unsealed package is incomplete', () => {
  const c = buildCoverage(model({ sealed: false, artefacts: { manifest: true, rawIndex: true, structured: true, provenance: true, sealed: false } }), PROFILE);
  assert.strictEqual(c.package.complete, false);
  assert.strictEqual(c.coverageComplete, false);
});

test('failed integrity makes coverage incomplete', () => {
  const c = buildCoverage(model({ integrity: { records: { total: 9, verified: 8 }, rawHashes: { checked: 1, verified: 1 } } }), PROFILE);
  assert.strictEqual(c.integrity.status, 'failed');
  assert.strictEqual(c.coverageComplete, false);
});

test('unverified (no integrity result) is not complete', () => {
  const c = buildCoverage(model({ integrity: null }), PROFILE);
  assert.strictEqual(c.integrity.status, 'unverified');
  assert.strictEqual(c.coverageComplete, false);
});
