'use strict';

// evidence-path.test.js — Collection Package path-helper tests.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ep = require('./evidence-path');

test('safeName strips unsafe chars (incl. timestamp colons) and keeps dots/dashes', () => {
  assert.strictEqual(ep.safeName('snapshot.json'), 'snapshot.json');
  assert.strictEqual(ep.safeName('segment-0001.json'), 'segment-0001.json');
  assert.strictEqual(ep.safeName('2026-06-29T00:00:00Z'), '2026-06-29T00_00_00Z');
  assert.strictEqual(ep.safeName('a/b c'), 'a_b_c');
});

test('package path builders compose the snapshot package layout', () => {
  const dir = ep.runDir('/runs', 'SNAP-1');
  assert.strictEqual(dir, path.join('/runs', 'SNAP-1'));
  assert.strictEqual(ep.rawDir(dir), path.join(dir, 'raw'));
  assert.strictEqual(ep.structuredDir(dir), path.join(dir, 'structured'));
  assert.strictEqual(ep.provenanceDir(dir), path.join(dir, 'provenance'));
  assert.strictEqual(ep.reportsDir(dir), path.join(dir, 'reports'));
  assert.strictEqual(ep.manifestPath(dir), path.join(dir, 'manifest.json'));
  assert.strictEqual(ep.sealPath(dir), path.join(dir, 'SEALED'));
  assert.strictEqual(ep.rawIndexPath(dir), path.join(dir, 'raw', 'raw-index.ndjson'));
  assert.strictEqual(ep.rawSegmentPath(dir), path.join(dir, 'raw', 'snapshot.json'));
  assert.strictEqual(ep.rawSegmentPath(dir, 'segment-0001.json'), path.join(dir, 'raw', 'segment-0001.json'));
});

test('runId is path-safened in the run directory name', () => {
  assert.strictEqual(ep.runDir('/runs', '2026-06-29T00:00:00Z'), path.join('/runs', '2026-06-29T00_00_00Z'));
});

test('PACKAGE_DIRS lists the four package subdirectories', () => {
  assert.deepStrictEqual([...ep.PACKAGE_DIRS], ['raw', 'structured', 'provenance', 'reports']);
});
