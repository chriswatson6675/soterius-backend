'use strict';

// run-snapshot.test.js — end-to-end orchestration tests.
//
// Covers a full successful pipeline, a forced failure at EACH stage (Observe,
// Preserve, Extract, Provenance, Integrity, Seal), the lifecycle transitions, the
// "never seal a failure / never delete evidence" guarantees, and deterministic
// repeated execution. Stage failures are injected via opts.deps; earlier stages
// use the REAL modules so we can assert their artefacts survive.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectSnapshot } = require('./run-snapshot');
const { isSealed } = require('./collection-package');
const { defineSource } = require('./snapshot-source');
const { rawSegmentPath, structuredDir, manifestPath } = require('./evidence-path');
const { lineagePath } = require('./provenance');
const { STATES, SEQUENCE } = require('./collection-run');

const SRC = defineSource({ recordsPath: ['firms'], officesPath: ['offices'], anchorPath: ['SRA number'], productionTimestampPath: ['productionDate'] });
const SNAPSHOT = JSON.stringify({
  productionDate: '2026-06-28T23:00:00Z',
  firms: [
    { 'SRA number': '100001', Name: 'Acme Legal LLP', offices: [{ officeId: '100001-0', website: 'https://acme.example' }] },
    { 'SRA number': '100002', Name: 'Beta Law Ltd', offices: [] },
  ],
});

const CONFIG = { baseUrl: 'https://x', subscriptionKey: 'KEY' };
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sra-run-')); }
function okFetch(raw = SNAPSHOT) { return async () => ({ statusCode: 200, headers: {}, bodyBuffer: Buffer.from(raw, 'utf8') }); }

function base(overrides = {}) {
  return { config: CONFIG, runRoot: tmpRoot(), source: SRC, runId: 'SNAP-1', now: () => '2026-06-29T00:00:00Z', _fetch: okFetch(), ...overrides };
}
function structFile(dir) { return path.join(structuredDir(dir), 'firm.ndjson'); }

test('successful end-to-end orchestration produces a SEALED package', async () => {
  const r = await collectSnapshot(base());

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sealed, true);
  assert.strictEqual(r.state, STATES.SEALED);
  assert.strictEqual(r.failedStage, null);
  assert.strictEqual(r.productionTimestamp, '2026-06-28T23:00:00Z');
  assert.strictEqual(r.integrity.ok, true);

  // every artefact exists and the package is sealed
  assert.ok(fs.existsSync(rawSegmentPath(r.dir, 'snapshot.json')));
  assert.ok(fs.existsSync(manifestPath(r.dir)));
  assert.ok(fs.existsSync(structFile(r.dir)));
  assert.ok(fs.existsSync(lineagePath(r.dir)));
  assert.strictEqual(isSealed(r.dir), true);

  // lifecycle ran the full sequence in order
  assert.deepStrictEqual(r.history.map((h) => h.state), [...SEQUENCE]);
  assert.strictEqual(r.stages.observe.segmentCount, 1);
  assert.ok(r.stages.extract.records > 0);
});

test('Observe failure: stops, no package sealed, no raw written', async () => {
  const r = await collectSnapshot(base({ deps: { acquireSnapshot: async () => ({ ok: false, error: { errorType: 'HTTP_ERROR', httpStatus: 500 }, segments: [] }) } }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failedStage, 'observe');
  assert.match(r.error, /HTTP 500/);
  assert.strictEqual(r.state, STATES.FAILED);
  assert.strictEqual(r.sealed, false);
  assert.ok(!fs.existsSync(rawSegmentPath(r.dir, 'snapshot.json')));
  assert.strictEqual(isSealed(r.dir), false);
});

test('Preserve failure: stops, no manifest, no seal', async () => {
  const fakePreserver = { preserveSegment() { throw new Error('disk full'); }, tally() { return { segmentCount: 0, totalBytes: 0, segments: [] }; } };
  const r = await collectSnapshot(base({ deps: { createPreserver: () => fakePreserver } }));
  assert.strictEqual(r.failedStage, 'preserve');
  assert.strictEqual(r.state, STATES.FAILED);
  assert.ok(!fs.existsSync(manifestPath(r.dir)));
  assert.strictEqual(isSealed(r.dir), false);
});

test('Extract failure: raw + manifest preserved, no structured, no seal', async () => {
  const r = await collectSnapshot(base({ deps: { extractRun: () => { throw new Error('extract boom'); } } }));
  assert.strictEqual(r.failedStage, 'extract');
  assert.strictEqual(r.state, STATES.FAILED);
  assert.ok(fs.existsSync(rawSegmentPath(r.dir, 'snapshot.json')), 'raw preserved');
  assert.ok(fs.existsSync(manifestPath(r.dir)), 'manifest preserved');
  assert.ok(!fs.existsSync(structFile(r.dir)));
  assert.strictEqual(isSealed(r.dir), false);
});

test('Provenance failure: structured preserved, no lineage, no seal', async () => {
  const r = await collectSnapshot(base({ deps: { writeLineage: () => { throw new Error('lineage boom'); } } }));
  assert.strictEqual(r.failedStage, 'provenance');
  assert.ok(fs.existsSync(structFile(r.dir)), 'structured preserved');
  assert.ok(!fs.existsSync(lineagePath(r.dir)));
  assert.strictEqual(isSealed(r.dir), false);
});

test('Integrity failure: everything preserved but NOT sealed', async () => {
  const r = await collectSnapshot(base({ deps: { verifyPackage: () => ({ ok: false, rawHashes: { checked: 1, verified: 0, failures: [{ file: 'snapshot.json', reason: 'sha256 mismatch' }] }, records: { total: 1, verified: 0, failures: [] } }) } }));
  assert.strictEqual(r.failedStage, 'verify');
  assert.strictEqual(r.state, STATES.FAILED);
  assert.strictEqual(r.sealed, false);
  assert.ok(fs.existsSync(lineagePath(r.dir)), 'lineage preserved');
  assert.strictEqual(isSealed(r.dir), false, 'a package failing integrity is NEVER sealed');
});

test('Seal failure: verified but seal errors → not sealed, evidence intact', async () => {
  const r = await collectSnapshot(base({ deps: { seal: () => { throw new Error('seal write error'); } } }));
  assert.strictEqual(r.failedStage, 'seal');
  assert.strictEqual(r.state, STATES.FAILED);
  assert.strictEqual(r.sealed, false);
  // integrity had already passed, and all evidence remains
  assert.strictEqual(r.integrity.ok, true);
  assert.ok(fs.existsSync(structFile(r.dir)) && fs.existsSync(lineagePath(r.dir)));
  assert.strictEqual(isSealed(r.dir), false);
});

test('missing required inputs throw (programmer error)', async () => {
  await assert.rejects(() => collectSnapshot({ runRoot: tmpRoot() }), /requires config/);
  await assert.rejects(() => collectSnapshot({ config: CONFIG }), /requires runRoot/);
});

test('deterministic repeated execution: identical inputs → identical result', async () => {
  const a = await collectSnapshot(base());
  const b = await collectSnapshot(base());
  const norm = (r) => { const c = { ...r }; delete c.dir; return c; }; // only the temp dir differs
  assert.deepStrictEqual(norm(a), norm(b));
  assert.strictEqual(a.sealed && b.sealed, true);
});
