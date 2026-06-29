'use strict';

// manifest.test.js — Collection Package manifest tests.
//
// Verifies operational-metadata-only content, default version/authority, tolerance
// of an empty preservation tally, no derived/interpretive fields, and write/read.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildManifest, writeManifest, readManifest, COLLECTOR_VERSION, SOURCE_AUTHORITY } = require('./manifest');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sra-manifest-')); }

test('buildManifest carries operational metadata and defaults version/authority', () => {
  const m = buildManifest(
    {
      runId: 'SNAP-1',
      collectionStartedAt: '2026-06-29T00:00:00Z',
      collectionCompletedAt: '2026-06-29T00:01:00Z',
      snapshotProductionTimestamp: '2026-06-28T23:00:00Z',
    },
    {
      segmentCount: 2,
      totalBytes: 30,
      segments: [
        { file: 'segment-0001.json', byteLength: 10, sha256: 'a' },
        { file: 'segment-0002.json', byteLength: 20, sha256: 'b' },
      ],
    },
  );
  assert.strictEqual(m.artefactType, 'sra-collection-manifest');
  assert.strictEqual(m.runId, 'SNAP-1');
  assert.strictEqual(m.collectorVersion, COLLECTOR_VERSION);
  assert.strictEqual(m.sourceAuthority, SOURCE_AUTHORITY);
  assert.strictEqual(m.collectionStartedAt, '2026-06-29T00:00:00Z');
  assert.strictEqual(m.collectionCompletedAt, '2026-06-29T00:01:00Z');
  assert.strictEqual(m.snapshotProductionTimestamp, '2026-06-28T23:00:00Z');
  assert.strictEqual(m.segmentCount, 2);
  assert.strictEqual(m.totalBytes, 30);
  assert.strictEqual(m.segments.length, 2);
  assert.strictEqual(m.segments[0].sha256, 'a');
  assert.strictEqual(m.recordCount, null); // unknown until extraction → null (no derived info)
});

test('buildManifest tolerates an empty/absent preservation tally', () => {
  const m = buildManifest({ runId: 'SNAP-2' });
  assert.deepStrictEqual(m.segments, []);
  assert.strictEqual(m.segmentCount, 0);
  assert.strictEqual(m.totalBytes, 0);
  assert.strictEqual(m.snapshotProductionTimestamp, null);
  assert.strictEqual(m.recordCount, null);
});

test('manifest exposes ONLY operational fields (no derived/interpretive content)', () => {
  const m = buildManifest({ runId: 'SNAP-3' }, { segmentCount: 0, totalBytes: 0, segments: [] });
  const allowed = new Set([
    'artefactType', 'note', 'runId', 'collectorVersion', 'sourceAuthority',
    'collectionStartedAt', 'collectionCompletedAt', 'snapshotProductionTimestamp',
    'segments', 'segmentCount', 'totalBytes', 'recordCount',
  ]);
  for (const k of Object.keys(m)) assert.ok(allowed.has(k), `unexpected manifest field: ${k}`);
});

test('totalBytes/segmentCount fall back to the segment array when not supplied', () => {
  const m = buildManifest({ runId: 'SNAP-3b' }, { segments: [
    { file: 'snapshot.json', byteLength: 7, sha256: 'x' },
  ] });
  assert.strictEqual(m.segmentCount, 1);
  assert.strictEqual(m.totalBytes, 7);
});

test('write/read round-trips the manifest on disk', () => {
  const dir = tmp();
  const m = buildManifest({ runId: 'SNAP-4' }, { segmentCount: 1, totalBytes: 5, segments: [{ file: 'snapshot.json', byteLength: 5, sha256: 'x' }] });
  const p = writeManifest(dir, m);
  assert.ok(fs.existsSync(p));
  assert.deepStrictEqual(readManifest(dir), m);
});
