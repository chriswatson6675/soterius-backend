'use strict';

// provenance.test.js — additive provenance / lineage tests.
//
// Covers envelope composition, lineage generation, snapshot identity + run identity
// + organisational anchor preservation, NO value duplication, immutability of raw +
// structured evidence, and deterministic regeneration.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { composeEnvelope, writeLineage, lineagePath } = require('./provenance');
const { createPackage } = require('./collection-package');
const { createPreserver } = require('./preserve-snapshot');
const { extractRun } = require('./extract');
const { buildManifest, writeManifest } = require('./manifest');
const { defineSource } = require('./snapshot-source');
const { structuredDir, rawSegmentPath } = require('./evidence-path');

const SRC = defineSource({ recordsPath: ['firms'], officesPath: ['offices'], anchorPath: ['SRA number'], productionTimestampPath: ['productionDate'] });
const SNAPSHOT = JSON.stringify({
  productionDate: '2026-06-28T23:00:00Z',
  firms: [
    { 'SRA number': '100001', Name: 'Acme Legal LLP', offices: [{ officeId: '100001-0', website: 'https://acme.example' }] },
    { 'SRA number': '100002', Name: 'Beta Law Ltd', offices: [] },
  ],
});

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sra-prov-')); }

// Full pipeline: package → preserve → manifest → extract.
function extractedPackage(runId = 'SNAP-1') {
  const dir = createPackage(tmpRoot(), runId);
  const tally = createPreserver(dir, { runId }).preserveSegment(SNAPSHOT, { name: 'snapshot.json', productionTimestamp: '2026-06-28T23:00:00Z' });
  writeManifest(dir, buildManifest(
    { runId, collectionStartedAt: '2026-06-29T00:00:00Z', snapshotProductionTimestamp: '2026-06-28T23:00:00Z' },
    { segmentCount: 1, totalBytes: tally.byteLength, segments: [{ file: tally.file, byteLength: tally.byteLength, sha256: tally.sha256 }] },
  ));
  extractRun(dir, { source: SRC });
  return dir;
}
function readLineage(dir) {
  return fs.readFileSync(lineagePath(dir), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function readStructuredRecs(dir) {
  return fs.readFileSync(path.join(structuredDir(dir), 'firm.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('composeEnvelope reuses run + record provenance and duplicates NO value', () => {
  const manifest = { runId: 'SNAP-1', collectorVersion: 'sra-snapshot-collector/0.1.0', sourceAuthority: 'Solicitors Regulation Authority' };
  const rec = { runId: 'SNAP-1', sourceId: 'sra', anchor: '100001', snapshotProductionTimestamp: '2026-06-28T23:00:00Z', objectType: 'sra.firm', key: null, rawArtefact: 'snapshot.json', segment: 0, jsonPath: 'firms[0]', path: ['firms', 0], value: { huge: 'object' } };
  const env = composeEnvelope(manifest, rec);

  assert.strictEqual(env.runId, 'SNAP-1');
  assert.strictEqual(env.sourceAuthority, 'Solicitors Regulation Authority');
  assert.strictEqual(env.snapshotProductionTimestamp, '2026-06-28T23:00:00Z');
  assert.strictEqual(env.anchor, '100001');
  assert.strictEqual(env.rawArtefact, 'snapshot.json');
  assert.deepStrictEqual(env.path, ['firms', 0]);
  assert.ok(!('value' in env), 'provenance NEVER duplicates the evidence value');
  assert.deepStrictEqual(env.chain, [
    'run:SNAP-1', 'source:sra', 'anchor:100001', 'raw:raw/snapshot.json', 'jsonPath:firms[0]', 'structured:structured/firm.ndjson',
  ]);
});

test('writeLineage generates one envelope per structured record', () => {
  const dir = extractedPackage();
  const { lineageRecords } = writeLineage(dir);
  const recs = readStructuredRecs(dir);
  const lineage = readLineage(dir);
  assert.strictEqual(lineageRecords, recs.length);
  assert.strictEqual(lineage.length, recs.length);
});

test('lineage preserves snapshot identity, run identity and organisational anchor', () => {
  const dir = extractedPackage('SNAP-XYZ');
  writeLineage(dir);
  const lineage = readLineage(dir);
  for (const env of lineage) {
    assert.strictEqual(env.runId, 'SNAP-XYZ', 'collection run identity preserved');
    assert.strictEqual(env.snapshotProductionTimestamp, '2026-06-28T23:00:00Z', 'snapshot production timestamp preserved');
    assert.strictEqual(env.sourceAuthority, 'Solicitors Regulation Authority', 'source authority preserved');
  }
  // anchor preserved for firm-derived observations
  const firmEnv = lineage.find((e) => e.objectType === 'sra.firm' && e.path[1] === 0);
  assert.strictEqual(firmEnv.anchor, '100001');
});

test('every lineage envelope carries a raw artefact reference + navigable path', () => {
  const dir = extractedPackage();
  writeLineage(dir);
  for (const env of readLineage(dir)) {
    assert.strictEqual(env.rawArtefact, 'snapshot.json');
    assert.ok(Array.isArray(env.path));
    assert.strictEqual(typeof env.jsonPath, 'string');
  }
});

test('provenance NEVER modifies raw or structured evidence', () => {
  const dir = extractedPackage();
  const rawBefore = fs.readFileSync(rawSegmentPath(dir, 'snapshot.json'), 'utf8');
  const structBefore = fs.readFileSync(path.join(structuredDir(dir), 'firm.ndjson'), 'utf8');
  writeLineage(dir);
  assert.strictEqual(fs.readFileSync(rawSegmentPath(dir, 'snapshot.json'), 'utf8'), rawBefore, 'raw unchanged');
  assert.strictEqual(fs.readFileSync(path.join(structuredDir(dir), 'firm.ndjson'), 'utf8'), structBefore, 'structured unchanged');
});

test('writeLineage is deterministic / regenerable (identical output on repeat)', () => {
  const dir = extractedPackage();
  writeLineage(dir);
  const first = fs.readFileSync(lineagePath(dir), 'utf8');
  writeLineage(dir);
  const second = fs.readFileSync(lineagePath(dir), 'utf8');
  assert.strictEqual(first, second);
});

test('writeLineage throws when there is no structured evidence', () => {
  const dir = createPackage(tmpRoot(), 'EMPTY');
  assert.throws(() => writeLineage(dir), /no structured evidence/);
});
