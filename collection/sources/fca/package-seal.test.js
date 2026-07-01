'use strict';

// package-seal.test.js — FCA Collection Package sealing preconditions + immutability.
// Crafts minimal package directories (the seal gate reads reports presence + manifest
// + the integrity/processed flags) to verify each rule deterministically.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { sealPackage, evaluateSealable, isSealed, readSeal, REQUIRED_REPORTS } = require('./package-seal');
const platformPackage = require('../sra/collection-package');

const FIXED_NOW = () => '2026-06-29T00:00:00.000Z';

// A minimal sealable package: manifest.json (platform completeness artefact) + reports.
function makePkg({ reports = true, manifest = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fca-seal-'));
  if (manifest) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ artefactType: 'fca-run-manifest' }));
  if (reports) {
    fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
    for (const r of REQUIRED_REPORTS) fs.writeFileSync(path.join(dir, 'reports', r), '{}');
  }
  return dir;
}
const OK_STATE = { allFirmsProcessed: true, integrity: { ok: true }, packageId: 'pkg', now: FIXED_NOW };

test('a complete package is sealed (write-once SEALED marker written)', () => {
  const dir = makePkg();
  try {
    const r = sealPackage(dir, OK_STATE);
    assert.strictEqual(r.sealed, true);
    assert.ok(isSealed(dir), 'SEALED marker present');
    assert.strictEqual(readSeal(dir).runId, 'pkg');
    assert.strictEqual(readSeal(dir).sealedAt, '2026-06-29T00:00:00.000Z');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('incomplete package (not every firm processed) cannot be sealed', () => {
  const dir = makePkg();
  try {
    const r = sealPackage(dir, { ...OK_STATE, allFirmsProcessed: false });
    assert.strictEqual(r.sealed, false);
    assert.match(r.reasons.join(' '), /every firm/);
    assert.ok(!isSealed(dir), 'remains unsealed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('integrity failure prevents sealing', () => {
  const dir = makePkg();
  try {
    const r = sealPackage(dir, { ...OK_STATE, integrity: { ok: false } });
    assert.strictEqual(r.sealed, false);
    assert.match(r.reasons.join(' '), /integrity/);
    assert.ok(!isSealed(dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing run-level reports prevent sealing', () => {
  const dir = makePkg({ reports: false });
  try {
    const r = sealPackage(dir, OK_STATE);
    assert.strictEqual(r.sealed, false);
    assert.match(r.reasons.join(' '), /reports/);
    assert.ok(!isSealed(dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the seal is immutable and is never resealed (idempotent)', () => {
  const dir = makePkg();
  try {
    const first = sealPackage(dir, OK_STATE);
    assert.strictEqual(first.sealed, true);
    const sealedBytes = fs.readFileSync(path.join(dir, 'SEALED'), 'utf8');

    // Re-sealing returns the existing seal, does not rewrite it.
    const again = sealPackage(dir, { ...OK_STATE, now: () => '2099-01-01T00:00:00.000Z' });
    assert.strictEqual(again.sealed, true);
    assert.strictEqual(again.alreadySealed, true);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'SEALED'), 'utf8'), sealedBytes, 'SEALED unchanged');

    // The platform primitive itself enforces write-once.
    assert.throws(() => platformPackage.seal(dir, { runId: 'pkg' }), /already sealed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('evaluateSealable reports every failing precondition together', () => {
  const dir = makePkg({ reports: false });
  try {
    const ev = evaluateSealable(dir, { allFirmsProcessed: false, integrity: { ok: false } });
    assert.strictEqual(ev.ok, false);
    assert.strictEqual(ev.reasons.length, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
