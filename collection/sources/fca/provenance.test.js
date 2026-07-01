'use strict';

// provenance.test.js — Phase 6 provenance + integrity tests (IMP-FCA-001 §6).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractRun } = require('./extract');
const { composeEnvelope, verifyIntegrity, verifyRun, writeLineage, lineagePath } = require('./provenance');

const MANIFEST = { runId: 'RID', collectorVersion: 'fca-reference-collector/0.1.0', apiVersion: 'V0.1' };

function tmpRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fca-prov-'));
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  return dir;
}
function writeRaw(dir, endpointId, bodyObj, extra = {}) {
  const line = {
    runId: 'RID', family: 'firm', anchor: '122702', endpointId, dependencyId: extra.dependencyId ?? null,
    pageSequence: 1, requestUri: `https://register.fca.org.uk/services/V0.1/${endpointId}`,
    collectionTimestamp: '2026-06-29T10:00:00Z', transport: 'NONE', httpStatus: 200,
    responseHeaders: { 'content-type': 'application/json' }, fcaEnvelope: { status: extra.status ?? 'FSR-API-XX-00', message: null, resultInfo: null },
    rawBody: typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj),
  };
  fs.appendFileSync(path.join(dir, 'raw', `${endpointId}.ndjson`), JSON.stringify(line) + '\n');
}
function aStructuredRecord(dir, endpointId) {
  const f = path.join(dir, 'structured', `${endpointId}.ndjson`);
  return JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n')[0]);
}

test('composeEnvelope carries the full §8 fields, the chain, and NO credential', () => {
  const rec = { runId: 'RID', endpointId: 'firm.address', anchor: '122702', dependencyId: null,
    rawArtefact: 'firm.address.ndjson', rawLine: 1, pageSequence: 1, objectType: 'firm.address.item',
    key: null, jsonPath: 'Data[0]', path: ['Data', 0], value: { 'Website Address': 'x' }, fcaStatus: 'FSR-API-02-02-00' };
  const rawLine = { requestUri: 'https://register.fca.org.uk/services/V0.1/Firm/122702/Address', httpStatus: 200, collectionTimestamp: '2026-06-29T10:00:00Z', fcaEnvelope: { status: 'FSR-API-02-02-00' } };
  const env = composeEnvelope(MANIFEST, rec, rawLine);

  for (const k of ['runId', 'collectorVersion', 'apiVersion', 'sourceAuthority', 'endpointId', 'requestUri', 'anchor', 'observationTimestamp', 'preservationTimestamp', 'rawArtefact', 'structuredArtefact', 'jsonPath', 'chain']) {
    assert.ok(env[k] !== undefined, `envelope has ${k}`);
  }
  assert.strictEqual(env.sourceAuthority, 'FCA Financial Services Register');
  assert.strictEqual(env.chain.length, 6, 'six-link lineage chain');
  assert.ok(!JSON.stringify(env).includes('X-Auth'), 'no credential header in envelope');
  assert.strictEqual(env.value, undefined, 'envelope carries NO evidence value (no duplication)');
});

test('verifyIntegrity recovers the value from the raw artefact at the JSON path', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm.address', { Data: [{ 'Website Address': 'www.barclays.com', 'Address LIne 3': '' }] });
  extractRun(dir);
  const rec = aStructuredRecord(dir, 'firm.address');
  const v = verifyIntegrity(dir, rec);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.equal, true);
});

test('verifyIntegrity fails on a tampered path/value (and never throws)', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm.address', { Data: [{ 'Website Address': 'www.barclays.com' }] });
  extractRun(dir);
  const rec = aStructuredRecord(dir, 'firm.address');
  const tampered = { ...rec, value: { 'Website Address': 'EVIL.example' } };
  assert.strictEqual(verifyIntegrity(dir, tampered).ok, false);
  const badPath = { ...rec, path: ['Data', 99] };
  assert.strictEqual(verifyIntegrity(dir, badPath).ok, false);
  const badArtefact = { ...rec, rawArtefact: 'nope.ndjson' };
  assert.strictEqual(verifyIntegrity(dir, badArtefact).located, false);
});

test('verifyRun verifies every structured record', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', { Data: [{ FRN: '122702' }] });
  writeRaw(dir, 'firm.permissions', { Data: { 'Accepting Deposits': [{ 'Customer Type': ['Customer'] }] } });
  writeRaw(dir, 'firm.regulators', { Data: [{ 'Regulator Name': 'FCA' }, { 'Regulator Name': 'PRA' }] });
  extractRun(dir);
  const r = verifyRun(dir);
  assert.ok(r.total >= 4);
  assert.strictEqual(r.verified, r.total);
  assert.deepStrictEqual(r.failures, []);
});

test('writeLineage is additive: raw/ and structured/ are byte-identical afterwards', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm', { Data: [{ FRN: '122702' }] });
  extractRun(dir);
  const rawBefore = fs.readFileSync(path.join(dir, 'raw', 'firm.ndjson'), 'utf8');
  const structBefore = fs.readFileSync(path.join(dir, 'structured', 'firm.ndjson'), 'utf8');

  const res = writeLineage(dir, MANIFEST);
  assert.ok(res.lineageRecords >= 1);
  assert.ok(fs.existsSync(lineagePath(dir)));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'raw', 'firm.ndjson'), 'utf8'), rawBefore, 'raw untouched');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'structured', 'firm.ndjson'), 'utf8'), structBefore, 'structured untouched');
});

test('lineage index contains no credential and no evidence value', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm.address', { Data: [{ 'Website Address': 'www.barclays.com' }] });
  extractRun(dir);
  writeLineage(dir, MANIFEST);
  const lineage = fs.readFileSync(lineagePath(dir), 'utf8');
  assert.ok(!/x-auth/i.test(lineage), 'no credential header');
  const first = JSON.parse(lineage.trim().split('\n')[0]);
  assert.strictEqual(first.value, undefined, 'lineage carries pointers, not values');
  assert.strictEqual(first.sourceAuthority, 'FCA Financial Services Register');
});
