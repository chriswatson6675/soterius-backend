'use strict';

// extract.test.js — Phase 5 extraction-driver tests (IMP-FCA-001 §5).
//
// Builds a synthetic preserved run directory (raw/*.ndjson, as Phase 4 writes),
// runs extractRun, and verifies structured output, traceability, verbatim fidelity,
// unknown-structure retention + discovery, append-only, and absence/failure skip.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractRun, structuredDir } = require('./extract');
const { getByPath } = require('./extract-map');

function tmpRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fca-extract-'));
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  return dir;
}

/** Write a preserved raw line (as Phase 4 would) for an endpoint. */
function writeRaw(dir, endpointId, bodyObj, extra = {}) {
  const rawBody = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  const line = {
    runId: 'RID', family: 'firm', anchor: '122702', endpointId,
    dependencyId: extra.dependencyId ?? null, pageSequence: extra.pageSequence ?? 1,
    requestUri: `https://x/${endpointId}`, collectionTimestamp: '2026-06-29T00:00:00Z',
    transport: extra.transport ?? 'NONE', httpStatus: extra.httpStatus ?? 200,
    responseHeaders: {}, fcaEnvelope: { status: extra.status ?? 'FSR-API-XX-00', message: null, resultInfo: null },
    rawBody: extra.transport && extra.transport !== 'NONE' ? null : rawBody,
  };
  fs.appendFileSync(path.join(dir, 'raw', `${endpointId}.ndjson`), JSON.stringify(line) + '\n');
}

function readStructured(dir, endpointId) {
  const f = path.join(structuredDir(dir), `${endpointId}.ndjson`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('extracts single, list, dynamic-map, names with traceability', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', { Status: 'FSR-API-02-01-00', Data: [{ FRN: '122702', 'Address LIne 3': '' }] });
  writeRaw(dir, 'firm.regulators', { Data: [{ 'Regulator Name': 'FCA' }, { 'Regulator Name': 'PRA' }] });
  writeRaw(dir, 'firm.permissions', { Data: { 'Accepting Deposits': [{ 'Customer Type': ['Customer'] }] } });
  writeRaw(dir, 'firm.names', { Data: [{ 'Current Names': [{ Name: 'Barclays' }] }] });

  const { tally } = extractRun(dir);
  assert.ok(tally.structuredRecords >= 5);

  const firm = readStructured(dir, 'firm')[0];
  assert.strictEqual(firm.jsonPath, 'Data[0]');
  assert.strictEqual(firm.value.FRN, '122702');
  assert.strictEqual(firm.rawArtefact, 'firm.ndjson');
  assert.strictEqual(firm.rawLine, 1);
  assert.strictEqual(firm.runId, 'RID');

  const perms = readStructured(dir, 'firm.permissions');
  assert.strictEqual(perms[0].key, 'Accepting Deposits');
});

test('structured value is recoverable from the preserved raw artefact (traceability)', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm.address', { Data: [{ 'Website Address': 'www.barclays.com', 'Address LIne 3': '' }] });
  extractRun(dir);

  const rec = readStructured(dir, 'firm.address')[0];
  // Re-open the EXACT preserved artefact + line, navigate the recorded path, compare.
  const rawLines = fs.readFileSync(path.join(dir, 'raw', rec.rawArtefact), 'utf8').trim().split('\n');
  const preserved = JSON.parse(rawLines[rec.rawLine - 1]);
  const navigated = getByPath(JSON.parse(preserved.rawBody), rec.path);
  assert.deepStrictEqual(navigated, rec.value, 'structured value === value at its raw JSON path');
  assert.strictEqual(rec.value['Address LIne 3'], '', 'irregular key + null-ish value preserved verbatim');
});

test('extraction never exceeds preservation (value is a subtree of the raw body)', () => {
  const dir = tmpRun();
  const body = { Data: [{ a: 1, nested: { b: [2, 3] } }] };
  writeRaw(dir, 'firm', body);
  extractRun(dir);
  const rec = readStructured(dir, 'firm')[0];
  assert.deepStrictEqual(rec.value, body.Data[0]); // identical, nothing added
});

test('unknown structure: retained verbatim + recorded as a discovery candidate', () => {
  const dir = tmpRun();
  // 'firm' expects Data array; give an object → fallback + discovery, no loss.
  writeRaw(dir, 'firm', { Data: { surprising: 'shape' } });
  const { discoveries } = extractRun(dir);
  const rec = readStructured(dir, 'firm')[0];
  assert.strictEqual(rec.unrecognised, true);
  assert.deepStrictEqual(rec.value, { surprising: 'shape' });
  assert.strictEqual(discoveries.length, 1);
  assert.match(discoveries[0].description, /unrecognised shape/);
});

test('observed-absence (Data:null) yields no structured records, no crash', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm.requirements.investmentTypes', { Status: 'FSR-API-02-13-11', Data: null }, { status: 'FSR-API-02-13-11' });
  const { tally } = extractRun(dir);
  assert.strictEqual(readStructured(dir, 'firm.requirements.investmentTypes').length, 0);
  assert.strictEqual(tally.structuredRecords, 0);
});

test('failed observation (transport != NONE) is skipped (stays in raw only)', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', {}, { transport: 'CONNECTION_ERROR', httpStatus: null });
  const { tally } = extractRun(dir);
  assert.strictEqual(tally.skipped, 1);
  assert.strictEqual(readStructured(dir, 'firm').length, 0);
});

test('populated investmentTypes (previously empty) extracts without code change', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm.requirements.investmentTypes', { Status: 'FSR-API-02-13-00', Data: [{ 'Investment Type': 'Share' }] }, { status: 'FSR-API-02-13-00' });
  extractRun(dir);
  const recs = readStructured(dir, 'firm.requirements.investmentTypes');
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].value['Investment Type'], 'Share');
});

test('does not modify the raw/ artefacts (run immutability)', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', { Data: [{ FRN: '1' }] });
  const before = fs.readFileSync(path.join(dir, 'raw', 'firm.ndjson'), 'utf8');
  extractRun(dir);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'raw', 'firm.ndjson'), 'utf8'), before);
});
