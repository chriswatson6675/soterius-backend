'use strict';

// collection-package.test.js — package layout, sealing, existence + recovery tests.
//
// Verifies the full package layout is created; that a package does NOT "exist"
// until SEALED; that sealing is write-once and refuses incomplete packages; and
// that an interrupted (unsealed) run is left recoverable and discoverable.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkg = require('./collection-package');
const ep = require('./evidence-path');
const { createPreserver } = require('./preserve-snapshot');
const { buildManifest, writeManifest } = require('./manifest');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sra-pkg-')); }

test('createPackage builds the full package layout (no manifest, no SEALED)', () => {
  const root = tmpRoot();
  const dir = pkg.createPackage(root, 'SNAP-1');
  for (const d of [ep.rawDir(dir), ep.structuredDir(dir), ep.provenanceDir(dir), ep.reportsDir(dir)]) {
    assert.ok(fs.existsSync(d) && fs.statSync(d).isDirectory(), `${d} should exist`);
  }
  assert.ok(!fs.existsSync(ep.manifestPath(dir)), 'manifest is NOT created by createPackage');
  assert.ok(!fs.existsSync(ep.sealPath(dir)), 'SEALED is NOT created by createPackage');
});

test('createPackage is idempotent and requires a runId', () => {
  const root = tmpRoot();
  assert.strictEqual(pkg.createPackage(root, 'SNAP-1'), pkg.createPackage(root, 'SNAP-1'));
  assert.throws(() => pkg.createPackage(root, ''), /requires a runId/);
  assert.throws(() => pkg.createPackage(root, null), /requires a runId/);
});

test('a package does NOT "exist" until SEALED is written', () => {
  const root = tmpRoot();
  const dir = pkg.createPackage(root, 'SNAP-1');
  assert.strictEqual(pkg.isSealed(dir), false);
  assert.strictEqual(pkg.packageExists(dir), false);
  assert.strictEqual(pkg.readSeal(dir), null);

  writeManifest(dir, buildManifest({ runId: 'SNAP-1' }));
  const rec = pkg.seal(dir, { runId: 'SNAP-1', collectorVersion: 'sra-snapshot-collector/0.1.0', now: () => '2026-06-29T00:05:00Z' });

  assert.strictEqual(rec.sealedAt, '2026-06-29T00:05:00Z');
  assert.strictEqual(rec.runId, 'SNAP-1');
  assert.strictEqual(pkg.isSealed(dir), true);
  assert.strictEqual(pkg.packageExists(dir), true);
  assert.deepStrictEqual(pkg.readSeal(dir), rec);
});

test('seal REFUSES an incomplete package (no manifest)', () => {
  const root = tmpRoot();
  const dir = pkg.createPackage(root, 'SNAP-1');
  assert.throws(() => pkg.seal(dir, { runId: 'SNAP-1' }), /manifest\.json is missing/);
  assert.strictEqual(pkg.isSealed(dir), false);
});

test('seal is WRITE-ONCE (cannot reseal an immutable package)', () => {
  const root = tmpRoot();
  const dir = pkg.createPackage(root, 'SNAP-1');
  writeManifest(dir, buildManifest({ runId: 'SNAP-1' }));
  pkg.seal(dir, { runId: 'SNAP-1' });
  assert.throws(() => pkg.seal(dir, { runId: 'SNAP-1' }), /already sealed/);
});

test('INTERRUPTED run leaves an UNSEALED package; recovery lists it', () => {
  const root = tmpRoot();

  // SNAP-OK: completed → preserved → manifest → sealed.
  const okDir = pkg.createPackage(root, 'SNAP-OK');
  createPreserver(okDir, { runId: 'SNAP-OK' }).preserveSegment('{"firms":[]}', { name: 'snapshot.json' });
  writeManifest(okDir, buildManifest({ runId: 'SNAP-OK' }));
  pkg.seal(okDir, { runId: 'SNAP-OK' });

  // SNAP-PARTIAL: raw partially preserved, then interrupted BEFORE sealing.
  const partialDir = pkg.createPackage(root, 'SNAP-PARTIAL');
  createPreserver(partialDir, { runId: 'SNAP-PARTIAL' }).preserveSegment('{"firms":[', { name: 'snapshot.json' });

  assert.deepStrictEqual(pkg.listSealed(root).map((p) => p.runId).sort(), ['SNAP-OK']);
  assert.deepStrictEqual(pkg.listUnsealed(root).map((p) => p.runId).sort(), ['SNAP-PARTIAL']);
  // The interrupted package is non-existent for consumers and safe to discard/re-acquire.
  assert.strictEqual(pkg.packageExists(partialDir), false);
});

test('listPackages reports seal state for every package', () => {
  const root = tmpRoot();
  pkg.createPackage(root, 'A');
  const b = pkg.createPackage(root, 'B');
  writeManifest(b, buildManifest({ runId: 'B' }));
  pkg.seal(b, { runId: 'B' });

  const all = pkg.listPackages(root).sort((x, y) => x.runId.localeCompare(y.runId));
  assert.deepStrictEqual(all, [
    { runId: 'A', dir: ep.runDir(root, 'A'), sealed: false },
    { runId: 'B', dir: ep.runDir(root, 'B'), sealed: true },
  ]);
});

test('listPackages on a missing root returns empty', () => {
  assert.deepStrictEqual(pkg.listPackages(path.join(os.tmpdir(), 'sra-no-such-root-xyz')), []);
});
