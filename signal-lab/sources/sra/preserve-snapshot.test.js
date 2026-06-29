'use strict';

// preserve-snapshot.test.js — immutable Preserve-sink tests.
//
// Verifies byte-for-byte preservation (incl. binary), append-only indexing with
// hash + byte count for future integrity verification, capture-once immutability
// (never overwrite), multi-segment tallying, and input validation.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createPreserver, sha256 } = require('./preserve-snapshot');
const { rawSegmentPath, rawIndexPath } = require('./evidence-path');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sra-preserve-')); }
function readIndex(dir) {
  return fs.readFileSync(rawIndexPath(dir), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// A payload with whitespace and key quirks, to prove no normalisation occurs.
const PAYLOAD = '{"productionDate":"2026-06-28","firms":[{"SRA number":"123456","Name":"Acme Legal LLP "}]}';

test('preserves the raw payload BYTE-FOR-BYTE (no transformation)', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'SNAP-1', now: () => '2026-06-29T00:00:00Z' });
  p.preserveSegment(PAYLOAD, { name: 'snapshot.json', requestUri: 'https://x/firms', productionTimestamp: '2026-06-28T23:00:00Z' });

  const onDisk = fs.readFileSync(rawSegmentPath(dir, 'snapshot.json'), 'utf8');
  assert.strictEqual(onDisk, PAYLOAD, 'payload preserved exactly, including the trailing space in "Acme Legal LLP "');
});

test('records an append-only index line with hash + byte count + provenance pointers', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'SNAP-1', now: () => '2026-06-29T00:00:00Z' });
  p.preserveSegment(PAYLOAD, { name: 'snapshot.json', requestUri: 'https://x/firms', productionTimestamp: '2026-06-28T23:00:00Z' });

  const idx = readIndex(dir);
  assert.strictEqual(idx.length, 1);
  assert.strictEqual(idx[0].file, 'snapshot.json');
  assert.strictEqual(idx[0].byteLength, Buffer.byteLength(PAYLOAD));
  assert.strictEqual(idx[0].sha256, sha256(Buffer.from(PAYLOAD, 'utf8')));
  assert.strictEqual(idx[0].sha256, crypto.createHash('sha256').update(Buffer.from(PAYLOAD)).digest('hex'));
  assert.strictEqual(idx[0].runId, 'SNAP-1');
  assert.strictEqual(idx[0].segment, 0);
  assert.strictEqual(idx[0].requestUri, 'https://x/firms');
  assert.strictEqual(idx[0].productionTimestamp, '2026-06-28T23:00:00Z');
  assert.strictEqual(idx[0].preservedAt, '2026-06-29T00:00:00Z');
});

test('NEVER overwrites a preserved segment (capture-once → throws; original intact)', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'SNAP-1' });
  p.preserveSegment(PAYLOAD, { name: 'snapshot.json' });
  assert.throws(() => p.preserveSegment('different', { name: 'snapshot.json' }), /already preserved/);
  assert.strictEqual(fs.readFileSync(rawSegmentPath(dir, 'snapshot.json'), 'utf8'), PAYLOAD);
  assert.strictEqual(readIndex(dir).length, 1, 'rejected write adds no index line');
});

test('appends multiple segments and tallies bytes/count', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'SNAP-1' });
  p.preserveSegment('aaa', { name: 'segment-0001.json' });
  p.preserveSegment('bbbb', { name: 'segment-0002.json' });
  const t = p.tally();
  assert.strictEqual(t.segmentCount, 2);
  assert.strictEqual(t.totalBytes, 7);
  assert.strictEqual(t.segments.length, 2);
  assert.deepStrictEqual(t.segments.map((s) => s.file), ['segment-0001.json', 'segment-0002.json']);
  assert.strictEqual(readIndex(dir).length, 2);
});

test('preserves BINARY payloads byte-for-byte', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'SNAP-1' });
  const bin = crypto.randomBytes(64);
  const rec = p.preserveSegment(bin, { name: 'snapshot.json' });
  assert.ok(fs.readFileSync(rawSegmentPath(dir, 'snapshot.json')).equals(bin));
  assert.strictEqual(rec.byteLength, 64);
  assert.strictEqual(rec.sha256, sha256(bin));
});

test('rejects a null/undefined payload', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'SNAP-1' });
  assert.throws(() => p.preserveSegment(null), /payload is required/);
  assert.throws(() => p.preserveSegment(undefined), /payload is required/);
});
