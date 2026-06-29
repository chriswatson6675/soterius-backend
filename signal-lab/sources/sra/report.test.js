'use strict';

// report.test.js — end-to-end reporting tests over real Collection Packages.
//
// Covers successful report generation (from a sealed package built by the real
// orchestrator), missing artefacts, incomplete packages, integrity failures,
// deterministic repeated reporting, the read-only guarantee, and writeReports
// leaving all evidence untouched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { generateReports, writeReports } = require('./report');
const { loadRunModel } = require('./snapshot-run-model');
const { collectSnapshot } = require('./run-snapshot');
const { createPackage } = require('./collection-package');
const { defineSource } = require('./snapshot-source');
const { rawSegmentPath, structuredDir, provenanceDir, manifestPath, sealPath, reportsDir } = require('./evidence-path');

const SRC = defineSource({ recordsPath: ['firms'], officesPath: ['offices'], anchorPath: ['SRA number'], productionTimestampPath: ['productionDate'] });
const SNAPSHOT = JSON.stringify({
  productionDate: '2026-06-28T23:00:00Z',
  firms: [
    { 'SRA number': '100001', Name: 'Acme Legal LLP', offices: [{ officeId: '100001-0', website: 'https://acme.example' }] },
    { 'SRA number': '100002', Name: 'Beta Law Ltd', offices: [] },
  ],
});
const CONFIG = { baseUrl: 'https://x', subscriptionKey: 'KEY' };

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sra-report-')); }
function okFetch(raw = SNAPSHOT) { return async () => ({ statusCode: 200, headers: {}, bodyBuffer: Buffer.from(raw, 'utf8') }); }

// Produce a sealed package via the real orchestrator.
async function sealedPackage(fetchRaw = SNAPSHOT) {
  const r = await collectSnapshot({ config: CONFIG, runRoot: tmpRoot(), source: SRC, runId: 'SNAP-1', now: () => '2026-06-29T00:00:00Z', _fetch: okFetch(fetchRaw) });
  assert.strictEqual(r.ok, true);
  return r.dir;
}

// A full byte-level fingerprint of every evidence artefact (to prove read-only).
function evidenceFingerprint(dir) {
  const files = [
    rawSegmentPath(dir, 'snapshot.json'),
    path.join(structuredDir(dir), 'firm.ndjson'),
    path.join(provenanceDir(dir), 'lineage.ndjson'),
    manifestPath(dir),
    sealPath(dir),
  ];
  return files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null));
}

test('successful report generation: four reports with consistent content', async () => {
  const dir = await sealedPackage();
  const reports = generateReports(dir);

  assert.strictEqual(reports.collection.reportType, 'collection-report');
  assert.strictEqual(reports.collection.runId, 'SNAP-1');
  assert.strictEqual(reports.collection.sealed, true);
  assert.strictEqual(reports.collection.snapshotProductionTimestamp, '2026-06-28T23:00:00Z');
  assert.ok(reports.collection.structuredRecords > 0);

  assert.strictEqual(reports.coverage.reportType, 'coverage-report');
  assert.strictEqual(reports.coverage.coverageComplete, true);
  assert.strictEqual(reports.coverage.integrity.status, 'verified');
  assert.strictEqual(reports.coverage.package.complete, true);

  assert.strictEqual(reports.health.reportType, 'health-report');
  assert.deepStrictEqual(reports.health.anomalies, []);
  assert.strictEqual(reports.health.integrity.ok, true);

  assert.strictEqual(reports.discoveries.reportType, 'discoveries-report');
  assert.strictEqual(reports.discoveries.count, 0);
});

test('generateReports is strictly READ-ONLY (no file created, evidence unchanged)', async () => {
  const dir = await sealedPackage();
  const before = evidenceFingerprint(dir);
  const reportsBefore = fs.existsSync(reportsDir(dir)) ? fs.readdirSync(reportsDir(dir)) : [];

  generateReports(dir);

  assert.deepStrictEqual(evidenceFingerprint(dir), before, 'evidence untouched');
  const reportsAfter = fs.existsSync(reportsDir(dir)) ? fs.readdirSync(reportsDir(dir)) : [];
  assert.deepStrictEqual(reportsAfter, reportsBefore, 'generateReports writes nothing');
});

test('writeReports writes reports/ only and never modifies evidence', async () => {
  const dir = await sealedPackage();
  const before = evidenceFingerprint(dir);

  writeReports(dir);

  assert.deepStrictEqual(evidenceFingerprint(dir), before, 'evidence untouched by writeReports');
  for (const f of ['collection-report.json', 'coverage-report.json', 'health-report.json', 'discoveries-report.json']) {
    assert.ok(fs.existsSync(path.join(reportsDir(dir), f)), `${f} written`);
  }
});

test('discoveries report surfaces unrecognised structures', async () => {
  // a record whose offices container is not an array → extract emits an unrecognised fallback
  const weird = JSON.stringify({ productionDate: '2026-06-28', firms: [{ 'SRA number': 'Z', offices: 'oops' }] });
  const dir = await sealedPackage(weird);
  const reports = generateReports(dir);
  assert.ok(reports.discoveries.count >= 1);
  assert.ok(reports.discoveries.discoveries.some((d) => d.objectType === 'sra.firm.office.raw'));
  assert.ok(reports.health.anomalies.some((a) => a.code === 'unrecognised-structures'));
});

test('missing artefacts: report still generated, marked incomplete', () => {
  const dir = createPackage(tmpRoot(), 'BARE'); // empty package: dirs only
  const reports = generateReports(dir);
  assert.strictEqual(reports.collection.runId, null);
  assert.strictEqual(reports.coverage.package.complete, false);
  assert.strictEqual(reports.coverage.coverageComplete, false);
  assert.ok(reports.health.anomalies.some((a) => a.code === 'missing-artefact'));
  assert.ok(reports.health.anomalies.some((a) => a.code === 'not-sealed'));
});

test('incomplete package (unsealed but built): coverage incomplete, integrity unverified', () => {
  // model an unsealed package directly via the model + reports
  const dir = createPackage(tmpRoot(), 'PARTIAL');
  const reports = generateReports(dir);
  assert.strictEqual(reports.collection.sealed, false);
  assert.strictEqual(reports.coverage.integrity.status, 'unverified');
  assert.strictEqual(reports.coverage.coverageComplete, false);
});

test('integrity failure: caller-supplied failing result is reflected, not repaired', async () => {
  const dir = await sealedPackage();
  const failing = { ok: false, records: { total: 9, verified: 7, failures: [{ reason: 'value mismatch at path' }] }, rawHashes: { checked: 1, verified: 0, failures: [{ file: 'snapshot.json', reason: 'sha256 mismatch' }] } };
  const reports = generateReports(dir, { integrity: failing });

  assert.strictEqual(reports.coverage.integrity.status, 'failed');
  assert.strictEqual(reports.coverage.coverageComplete, false);
  assert.ok(reports.health.anomalies.some((a) => a.code === 'integrity-failed'));
  assert.ok(reports.health.anomalies.some((a) => a.code === 'raw-hash-failure'));
  // reporting did not touch the package
  assert.strictEqual(fs.existsSync(path.join(reportsDir(dir), 'coverage-report.json')), false);
});

test('deterministic repeated reporting: identical output every time', async () => {
  const dir = await sealedPackage();
  const a = generateReports(dir);
  const b = generateReports(dir);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

test('run model reads persisted integrity from the SEALED marker', async () => {
  const dir = await sealedPackage();
  const model = loadRunModel(dir);
  assert.ok(model.integrity, 'integrity read from SEALED marker');
  assert.strictEqual(model.sealed, true);
  assert.strictEqual(model.structured.recordCount > 0, true);
});
