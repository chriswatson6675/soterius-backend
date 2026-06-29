'use strict';

// integrity.test.js — read-only integrity verification tests.
//
// Covers reconstruction success, value-tamper failure, corrupted raw (hash + parse),
// missing artefacts, package consistency, read-only guarantee, and deterministic
// repeated verification. Tampering is performed by the TEST (simulating corruption);
// the integrity layer itself only ever reads.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifyRecord, verifyRawHashes, verifyRun, verifyPackage } = require('./integrity');
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

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sra-integrity-')); }
function structFile(dir) { return path.join(structuredDir(dir), 'firm.ndjson'); }

function extractedPackage(runId = 'SNAP-1') {
  const dir = createPackage(tmpRoot(), runId);
  const idx = createPreserver(dir, { runId }).preserveSegment(SNAPSHOT, { name: 'snapshot.json', productionTimestamp: '2026-06-28T23:00:00Z' });
  writeManifest(dir, buildManifest({ runId, snapshotProductionTimestamp: '2026-06-28T23:00:00Z' },
    { segmentCount: 1, totalBytes: idx.byteLength, segments: [{ file: idx.file, byteLength: idx.byteLength, sha256: idx.sha256 }] }));
  extractRun(dir, { source: SRC });
  return dir;
}

test('verification success: every structured record reconstructs from immutable raw', () => {
  const dir = extractedPackage();
  const res = verifyRun(dir);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.verified, res.total);
  assert.ok(res.total > 0);
  assert.deepStrictEqual(res.failures, []);
});

test('raw-segment hashes verify against the append-only raw index', () => {
  const dir = extractedPackage();
  const h = verifyRawHashes(dir);
  assert.strictEqual(h.indexPresent, true);
  assert.strictEqual(h.checked, 1);
  assert.strictEqual(h.verified, 1);
  assert.deepStrictEqual(h.failures, []);
});

test('whole-package verification is consistent on a clean package', () => {
  const dir = extractedPackage();
  const res = verifyPackage(dir);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.manifest.consistent, true);
  assert.strictEqual(res.manifest.segmentsDeclared, 1);
  assert.strictEqual(res.manifest.segmentsIndexed, 1);
});

test('verification failure: a tampered structured VALUE no longer reconstructs', () => {
  const dir = extractedPackage();
  // TEST-side corruption of a structured record's value (not the integrity layer).
  const recs = fs.readFileSync(structFile(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const i = recs.findIndex((r) => r.objectType === 'sra.firm.field' && r.key === 'Name');
  recs[i].value = 'TAMPERED NAME';
  fs.writeFileSync(structFile(dir), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const res = verifyRun(dir);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.verified, res.total - 1);
  assert.ok(res.failures.some((f) => f.reason === 'value mismatch at path'));
});

test('corrupted raw evidence: hash mismatch + reconstruction failure', () => {
  const dir = extractedPackage();
  // TEST-side corruption of the raw segment bytes (still valid JSON, different value).
  const corrupt = JSON.stringify({ productionDate: '2026-06-28T23:00:00Z', firms: [{ 'SRA number': '999999', Name: 'Different', offices: [] }] });
  fs.writeFileSync(rawSegmentPath(dir, 'snapshot.json'), corrupt);

  const h = verifyRawHashes(dir);
  assert.strictEqual(h.verified, 0);
  assert.ok(h.failures.some((f) => f.reason === 'sha256 mismatch'));

  const res = verifyRun(dir);
  assert.strictEqual(res.ok, false, 'records no longer reconstruct from the corrupted raw');
});

test('corrupted raw evidence: unparseable raw is reported, not crashed', () => {
  const dir = extractedPackage();
  fs.writeFileSync(rawSegmentPath(dir, 'snapshot.json'), '<<not json any more>>');
  const res = verifyRun(dir);
  assert.strictEqual(res.ok, false);
  assert.ok(res.failures.some((f) => f.reason === 'raw artefact not JSON-parseable'));
});

test('missing artefact: deleted raw segment is reported as missing', () => {
  const dir = extractedPackage();
  fs.rmSync(rawSegmentPath(dir, 'snapshot.json'));
  const res = verifyRun(dir);
  assert.strictEqual(res.ok, false);
  assert.ok(res.failures.every((f) => f.reason === 'raw artefact missing'));

  const h = verifyRawHashes(dir);
  assert.ok(h.failures.some((f) => f.reason === 'missing'));

  assert.strictEqual(verifyPackage(dir).ok, false);
});

test('verifyRecord handles a record with no rawArtefact / no path', () => {
  const dir = extractedPackage();
  assert.match(verifyRecord(dir, { path: ['firms', 0], value: 1 }).reason, /no rawArtefact/);
  assert.match(verifyRecord(dir, { rawArtefact: 'snapshot.json', value: 1 }).reason, /no path/);
});

test('integrity verification is strictly READ-ONLY (no evidence is altered)', () => {
  const dir = extractedPackage();
  const rawBefore = fs.readFileSync(rawSegmentPath(dir, 'snapshot.json'), 'utf8');
  const structBefore = fs.readFileSync(structFile(dir), 'utf8');
  verifyRun(dir); verifyRawHashes(dir); verifyPackage(dir);
  assert.strictEqual(fs.readFileSync(rawSegmentPath(dir, 'snapshot.json'), 'utf8'), rawBefore);
  assert.strictEqual(fs.readFileSync(structFile(dir), 'utf8'), structBefore);
});

test('deterministic repeated verification: identical results every time', () => {
  const dir = extractedPackage();
  assert.deepStrictEqual(verifyRun(dir), verifyRun(dir));
  assert.deepStrictEqual(verifyPackage(dir), verifyPackage(dir));
});

test('verifyRun throws when there is no structured evidence', () => {
  const dir = createPackage(tmpRoot(), 'EMPTY');
  assert.throws(() => verifyRun(dir), /no structured evidence/);
});
