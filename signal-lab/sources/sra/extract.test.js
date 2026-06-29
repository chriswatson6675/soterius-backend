'use strict';

// extract.test.js — Extract layer read→write tests (through a real package).
//
// Covers extraction over preserved raw (via the Collection Package foundation),
// nested offices, unknown-field preservation, malformed/unparseable segments,
// empty datasets, deterministic repeated extraction, append-only guarding, raw
// immutability, and structured-evidence record shape (provenance sufficiency).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { extractRun } = require('./extract');
const { createPackage } = require('./collection-package');
const { createPreserver } = require('./preserve-snapshot');
const { structuredDir, rawSegmentPath } = require('./evidence-path');
const { defineSource } = require('./snapshot-source');

const SRC = defineSource({ recordsPath: ['firms'], officesPath: ['offices'], anchorPath: ['SRA number'], productionTimestampPath: ['productionDate'] });

const SNAPSHOT = JSON.stringify({
  productionDate: '2026-06-28T23:00:00Z',
  firms: [
    { 'SRA number': '100001', Name: 'Acme Legal LLP', offices: [{ officeId: '100001-0', website: 'https://acme.example' }] },
    { 'SRA number': '100002', Name: 'Beta Law Ltd', extras: { x: [1, 2] }, offices: [] },
  ],
});

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sra-extract-')); }

// Build a preserved package with one raw snapshot segment (the real Preserve path).
function preservedPackage(rawBody = SNAPSHOT, runId = 'SNAP-1') {
  const dir = createPackage(tmpRoot(), runId);
  createPreserver(dir, { runId }).preserveSegment(rawBody, { name: 'snapshot.json', productionTimestamp: '2026-06-28T23:00:00Z' });
  return dir;
}
function readStructured(dir) {
  const f = path.join(structuredDir(dir), 'firm.ndjson');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('successful extraction writes structured records and a typed tally', () => {
  const dir = preservedPackage();
  const { tally, records } = extractRun(dir, { source: SRC });

  assert.strictEqual(tally.segments, 1);
  assert.strictEqual(tally.segmentsParsed, 1);
  assert.strictEqual(tally.byObjectType['sra.firm'], 2);
  assert.strictEqual(tally.byObjectType['sra.firm.office'], 1);
  assert.strictEqual(records.length, tally.records);
  assert.deepStrictEqual(readStructured(dir), records, 'written file matches returned records');
});

test('nested office extraction is traceable to the raw segment path', () => {
  const dir = preservedPackage();
  extractRun(dir, { source: SRC });
  const recs = readStructured(dir);
  const office = recs.find((r) => r.objectType === 'sra.firm.office');
  assert.strictEqual(office.rawArtefact, 'snapshot.json');
  assert.deepStrictEqual(office.path, ['firms', 0, 'offices', 0]);
  assert.strictEqual(office.jsonPath, 'firms[0]["offices"][0]');
  assert.strictEqual(office.anchor, '100001');
  assert.deepStrictEqual(office.value, { officeId: '100001-0', website: 'https://acme.example' });
});

test('unknown nested field is preserved verbatim in structured output', () => {
  const dir = preservedPackage();
  extractRun(dir, { source: SRC });
  const extras = readStructured(dir).find((r) => r.objectType === 'sra.firm.field' && r.key === 'extras');
  assert.deepStrictEqual(extras.value, { x: [1, 2] });
});

test('malformed (unparseable) segment is recorded and skipped; raw left intact', () => {
  const dir = preservedPackage('<<not json>>');
  const before = fs.readFileSync(rawSegmentPath(dir, 'snapshot.json'), 'utf8');
  const { tally, discoveries, records } = extractRun(dir, { source: SRC });

  assert.strictEqual(tally.segmentsUnparseable, 1);
  assert.strictEqual(records.length, 0);
  assert.ok(discoveries.some((d) => d.type === 'segment-unparseable' && d.file === 'snapshot.json'));
  assert.strictEqual(fs.readFileSync(rawSegmentPath(dir, 'snapshot.json'), 'utf8'), before, 'raw evidence is NOT modified');
});

test('empty dataset → zero structured records, no file content', () => {
  const dir = preservedPackage(JSON.stringify({ productionDate: 'x', firms: [] }));
  const { tally, records } = extractRun(dir, { source: SRC });
  assert.strictEqual(records.length, 0);
  assert.strictEqual(tally.records, 0);
  assert.deepStrictEqual(readStructured(dir), []);
});

test('deterministic repeated extraction: identical raw → identical records', () => {
  const a = extractRun(preservedPackage(), { source: SRC }).records;
  const b = extractRun(preservedPackage(), { source: SRC }).records;
  assert.deepStrictEqual(a, b);
});

test('append-only: refuses to re-extract over existing structured evidence', () => {
  const dir = preservedPackage();
  extractRun(dir, { source: SRC });
  assert.throws(() => extractRun(dir, { source: SRC }), /already present/);
});

test('throws when there is no raw/ directory at all (not a package)', () => {
  const bare = tmpRoot(); // a directory with no raw/ subdirectory
  assert.throws(() => extractRun(bare, { source: SRC }), /no raw evidence/);
});

test('an empty package (raw/ exists but no segments) extracts zero records, no throw', () => {
  const dir = createPackage(tmpRoot(), 'EMPTY');
  const { tally, records } = extractRun(dir, { source: SRC });
  assert.strictEqual(tally.segments, 0);
  assert.strictEqual(records.length, 0);
});

test('structured evidence record carries every field the Provenance layer will need', () => {
  const dir = preservedPackage();
  extractRun(dir, { source: SRC });
  const rec = readStructured(dir).find((r) => r.objectType === 'sra.firm');

  // lineage chain
  assert.strictEqual(rec.runId, 'SNAP-1');
  assert.strictEqual(rec.sourceId, 'sra');
  assert.strictEqual(rec.anchor, '100001');
  assert.strictEqual(rec.snapshotProductionTimestamp, '2026-06-28T23:00:00Z');
  // integrity triple: rawArtefact + path + value (re-navigable against the preserved raw)
  assert.strictEqual(rec.rawArtefact, 'snapshot.json');
  assert.ok(Array.isArray(rec.path));
  assert.ok('value' in rec);
  // human locator
  assert.strictEqual(typeof rec.jsonPath, 'string');

  // prove the integrity triple actually re-navigates the preserved raw to the same value
  const body = JSON.parse(fs.readFileSync(rawSegmentPath(dir, rec.rawArtefact), 'utf8'));
  let cur = body;
  for (const seg of rec.path) cur = cur[seg];
  assert.deepStrictEqual(cur, rec.value, 'recorded path recovers the recorded value from the immutable raw');
});
