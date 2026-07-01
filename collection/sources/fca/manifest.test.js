'use strict';

// manifest.test.js — Phase 4 manifest tests (IMP-FCA-001 §4).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildManifest, writeManifest, readManifest } = require('./manifest');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fca-manifest-')); }

const META = {
  runId: 'RID', collectorVersion: 'fca-reference-collector/0.1.0', apiVersion: 'V0.1',
  family: 'firm', anchor: '122702', scope: ['firm', 'firm.address'],
  executionStart: '2026-06-29T00:00:00Z', executionEnd: '2026-06-29T00:00:05Z',
};
const TALLY = { endpointsAttempted: 3, endpointsPreserved: 2, pagesPreserved: 5, transportErrors: 0, artefacts: ['firm.ndjson', 'firm.address.ndjson'] };

test('buildManifest records collection metadata and tallies', () => {
  const m = buildManifest(META, TALLY);
  assert.strictEqual(m.runId, 'RID');
  assert.strictEqual(m.collectorVersion, 'fca-reference-collector/0.1.0');
  assert.strictEqual(m.anchor, '122702');
  assert.strictEqual(m.endpointsPreserved, 2);
  assert.strictEqual(m.pagesPreserved, 5);
  assert.deepStrictEqual(m.artefacts, ['firm.ndjson', 'firm.address.ndjson']);
});

test('manifest carries no evidence-derived/interpretive fields', () => {
  const m = buildManifest(META, TALLY);
  // Only collection-process metadata + the explicit disclaimer note; nothing about firm content.
  const allowed = new Set([
    'artefactType', 'note', 'runId', 'collectorVersion', 'apiVersion', 'family', 'anchor', 'scope',
    'executionStart', 'executionEnd', 'endpointsAttempted', 'endpointsPreserved', 'pagesPreserved',
    'transportErrors', 'artefacts',
  ]);
  for (const k of Object.keys(m)) assert.ok(allowed.has(k), `unexpected manifest field '${k}'`);
  assert.match(m.note, /does not summarise or interpret/i);
});

test('write/read round-trips', () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  const m = buildManifest(META, TALLY);
  writeManifest(dir, m);
  assert.deepStrictEqual(readManifest(dir), m);
});
