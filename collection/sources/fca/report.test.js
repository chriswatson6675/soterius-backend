'use strict';

// report.test.js — Phase 8 reporting tests (IMP-FCA-001 §8).
// Covers collection report, coverage, health, discoveries, generic reusability.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadRunModel, buildCollectionReport, scanDiscoveries, writeReports, GENERIC_PROFILE } = require('./report');
const { buildCoverage } = require('./coverage');
const { buildHealth } = require('./health');
const { FCA_PROFILE } = require('./fca-report-profile');
const { buildManifest, writeManifest } = require('./manifest');

function tmpRun() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fca-report-'));
  fs.mkdirSync(path.join(d, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(d, 'structured'), { recursive: true });
  return d;
}
function rawLine(endpointId, opts = {}) {
  return {
    runId: 'RID', family: 'firm', anchor: '122702', endpointId, dependencyId: opts.dependencyId ?? null, pageSequence: opts.pageSequence ?? 1,
    requestUri: `https://x/${endpointId}`, collectionTimestamp: 'T', transport: opts.transport ?? 'NONE', httpStatus: opts.transport && opts.transport !== 'NONE' ? null : 200,
    responseHeaders: {}, fcaEnvelope: { status: opts.status ?? 'FSR-API-02-01-00', resultInfo: opts.next ? { Next: opts.next } : {} },
    rawBody: (opts.transport && opts.transport !== 'NONE') ? null : JSON.stringify(opts.body ?? { Data: [{ x: 1 }], ResultInfo: opts.next ? { Next: opts.next } : {} }),
    attempts: opts.attempts ?? null,
  };
}
function writeRaw(dir, endpointId, lines) {
  fs.appendFileSync(path.join(dir, 'raw', `${endpointId}.ndjson`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
function writeStructured(dir, endpointId, recs) {
  fs.appendFileSync(path.join(dir, 'structured', `${endpointId}.ndjson`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function seed(dir, scope) {
  writeManifest(dir, buildManifest(
    { runId: 'RID', collectorVersion: 'fca-reference-collector/0.1.0', apiVersion: 'V0.1', family: 'firm', anchor: '122702', scope, executionStart: '2026-06-29T10:00:00Z', executionEnd: '2026-06-29T10:00:05Z' },
    { endpointsAttempted: 3, endpointsPreserved: 3, pagesPreserved: 4, transportErrors: 0, artefacts: [] },
  ));
}

test('collection report describes process and is consistent with manifest', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', [rawLine('firm')]);
  writeRaw(dir, 'firm.address', [rawLine('firm.address')]);
  writeRaw(dir, 'firm.names', [rawLine('firm.names', { next: 'https://x/firm.names?pgnp=2' }), rawLine('firm.names', { pageSequence: 2 })]);
  seed(dir, ['firm', 'firm.address', 'firm.names']);
  const model = loadRunModel(dir);
  const rep = buildCollectionReport(model, FCA_PROFILE);
  assert.strictEqual(rep.reportType, 'collection-report');
  assert.strictEqual(rep.sourceId, 'fca');
  assert.strictEqual(rep.artefacts.rawLines, 4);
  assert.strictEqual(rep.artefacts.rawLines, model.manifest.pagesPreserved, 'consistent with manifest pagesPreserved');
  assert.strictEqual(rep.pagination.multiPageEndpoints, 1);
  assert.match(rep.note, /Does NOT summarise organisational evidence/);
});

test('coverage report classifies data / empty / failed / not-observed', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', [rawLine('firm', { body: { Data: [{ FRN: '1' }] } })]);                  // data
  writeRaw(dir, 'firm.requirements.investmentTypes', [rawLine('firm.requirements.investmentTypes', { status: 'FSR-API-02-13-11', body: { Data: null } })]); // empty
  writeRaw(dir, 'firm.regulators', [rawLine('firm.regulators', { transport: 'CONNECTION_ERROR' })]); // failed
  seed(dir, ['firm', 'firm.requirements.investmentTypes', 'firm.regulators', 'firm.waivers']);     // firm.waivers not observed
  const model = loadRunModel(dir);
  const cov = buildCoverage(model, FCA_PROFILE, { scope: model.manifest.scope });
  const byId = Object.fromEntries(cov.perEndpoint.map((e) => [e.endpointId, e.state]));
  assert.strictEqual(byId['firm'], 'data');
  assert.strictEqual(byId['firm.requirements.investmentTypes'], 'empty');
  assert.strictEqual(byId['firm.regulators'], 'failed');
  assert.strictEqual(byId['firm.waivers'], 'not-observed');
  assert.strictEqual(cov.totals.notObserved, 1);
  assert.strictEqual(cov.coverageComplete, false);
  assert.match(cov.note, /Does NOT estimate missing evidence/);
});

test('coverage marks not-applicable when supplied (e.g. grandchild with no deps)', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', [rawLine('firm')]);
  seed(dir, ['firm', 'firm.passports.permission']);
  const model = loadRunModel(dir);
  const cov = buildCoverage(model, FCA_PROFILE, { scope: model.manifest.scope, notApplicable: ['firm.passports.permission'] });
  assert.strictEqual(cov.perEndpoint.find((e) => e.endpointId === 'firm.passports.permission').state, 'not-applicable');
  assert.strictEqual(cov.totals.notApplicable, 1);
});

test('health: retry rate, failures, manifest consistency, integrity', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', [rawLine('firm', { attempts: [{ outcome: 'transient' }, { outcome: 'success' }] })]); // 1 retried page
  writeRaw(dir, 'firm.address', [rawLine('firm.address')]);
  seed(dir, ['firm', 'firm.address']);
  // manifest seeded pagesPreserved=4 but we only wrote 2 → expect inconsistent
  const model = loadRunModel(dir);
  const h = buildHealth(model, FCA_PROFILE, { integrity: { verified: 5, total: 5 } });
  assert.strictEqual(h.retry.retriedPages, 1);
  assert.ok(h.retry.retryRate > 0);
  assert.strictEqual(h.retry.transientFailures, 1);
  assert.strictEqual(h.integrity.ok, true);
  assert.strictEqual(h.manifestConsistency.consistent, false); // 2 lines vs declared 4
});

test('discoveries appear only when an unrecognised structure exists', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', [rawLine('firm')]);
  seed(dir, ['firm']);
  let model = loadRunModel(dir);
  assert.deepStrictEqual(scanDiscoveries(model, FCA_PROFILE), [], 'no discoveries when clean');

  writeStructured(dir, 'firm', [{ endpointId: 'firm', anchor: '122702', jsonPath: 'Data', value: { weird: 1 }, unrecognised: true }]);
  model = loadRunModel(dir);
  const disc = scanDiscoveries(model, FCA_PROFILE);
  assert.strictEqual(disc.length, 1);
  assert.match(disc[0].discoveryId, /^FCA-DISC-/);
  assert.strictEqual(disc[0].endpoint, 'firm');
});

test('reporting core is GENERIC: same code works for another sourceId', () => {
  const dir = tmpRun();
  writeRaw(dir, 'company', [rawLine('company')]);
  seed(dir, ['company']);
  const model = loadRunModel(dir);
  const rep = buildCollectionReport(model, { sourceId: 'companies-house', classify: (s) => s.outcome, anomalies: () => [] });
  assert.strictEqual(rep.sourceId, 'companies-house');
  assert.strictEqual(rep.artefacts.rawFiles, 1);
});

test('writeReports is additive: writes reports/ and does not touch raw/structured', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', [rawLine('firm')]);
  writeStructured(dir, 'firm', [{ endpointId: 'firm', anchor: '122702', jsonPath: 'Data[0]', value: { FRN: '1' } }]);
  seed(dir, ['firm']);
  const rawBefore = fs.readFileSync(path.join(dir, 'raw', 'firm.ndjson'), 'utf8');
  const out = writeReports(dir, { profile: FCA_PROFILE, integrity: { verified: 1, total: 1 } });
  assert.ok(fs.existsSync(path.join(dir, 'reports', 'collection-report.json')));
  assert.ok(fs.existsSync(path.join(dir, 'reports', 'coverage-report.json')));
  assert.ok(fs.existsSync(path.join(dir, 'reports', 'health-report.json')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'raw', 'firm.ndjson'), 'utf8'), rawBefore, 'raw untouched');
  assert.strictEqual(out.collection.sourceId, 'fca');
});
