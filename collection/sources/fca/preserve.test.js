'use strict';

// preserve.test.js — Phase 4 Preserve-sink tests (IMP-FCA-001 §4).
//
// Verifies byte-faithful raw preservation, dynamic-structure fidelity, append-only
// behaviour, dependency-empty skipping, tally correctness, and no credential leak.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPreserver } = require('./preserve');
const { rawFileFor } = require('./evidence-path');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fca-preserve-')); }
function readLines(file) { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }

// A dynamic activity-keyed permissions body, with an irregular key, as a raw string.
const PERMISSIONS_RAW = JSON.stringify({
  Status: 'FSR-API-02-03-00',
  Data: { 'Accepting Deposits': [{ 'Customer Type': ['Customer'] }], 'Debt Adjusting': [{ Limitation: ['no debt management'] }] },
});
const FIRM_RAW = '{"Status":"FSR-API-02-01-00","ResultInfo":{"page":"1"},"Data":[{"FRN":"1","Address LIne 3":""}]}';

function syntheticExecution() {
  return {
    family: 'firm',
    anchor: '1',
    order: ['firm', 'firm.permissions', 'firm.passports.permission'],
    executions: [
      { endpointId: 'firm', status: 'executed', pages: [{ requestUri: 'https://x/Firm/1', response: {
        errorType: 'NONE', httpStatus: 200, requestUri: 'https://x/Firm/1',
        headers: { 'content-type': 'application/json' }, rawBody: FIRM_RAW,
        body: JSON.parse(FIRM_RAW), envelope: { status: 'FSR-API-02-01-00', message: null, resultInfo: { page: '1' } },
      } }] },
      { endpointId: 'firm.permissions', status: 'executed', pages: [{ requestUri: 'https://x/Firm/1/Permissions', response: {
        errorType: 'NONE', httpStatus: 200, requestUri: 'https://x/Firm/1/Permissions',
        headers: {}, rawBody: PERMISSIONS_RAW, body: JSON.parse(PERMISSIONS_RAW),
        envelope: { status: 'FSR-API-02-03-00', message: null, resultInfo: null },
      } }] },
      { endpointId: 'firm.passports.permission', dependsOn: 'firm.passports', status: 'dependency-empty', pages: [] },
    ],
  };
}

test('preserves raw body BYTE-FAITHFULLY (no transformation)', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'RID', now: () => '2026-06-29T00:00:00Z' });
  p.preserveExecution(syntheticExecution());

  const firmLines = readLines(rawFileFor(dir, 'firm'));
  assert.strictEqual(firmLines.length, 1);
  assert.strictEqual(firmLines[0].rawBody, FIRM_RAW, 'rawBody preserved exactly, including the "Address LIne 3" typo key');
  assert.strictEqual(firmLines[0].endpointId, 'firm');
  assert.strictEqual(firmLines[0].anchor, '1');
  assert.strictEqual(firmLines[0].runId, 'RID');
  assert.strictEqual(firmLines[0].collectionTimestamp, '2026-06-29T00:00:00Z');
  assert.strictEqual(firmLines[0].fcaEnvelope.status, 'FSR-API-02-01-00');
});

test('dynamic activity-keyed map is preserved intact', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'RID' });
  p.preserveExecution(syntheticExecution());
  const permLines = readLines(rawFileFor(dir, 'firm.permissions'));
  assert.strictEqual(permLines[0].rawBody, PERMISSIONS_RAW);
  const reparsed = JSON.parse(permLines[0].rawBody);
  assert.deepStrictEqual(Object.keys(reparsed.Data), ['Accepting Deposits', 'Debt Adjusting']);
});

test('dependency-empty executions write nothing', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'RID' });
  p.preserveExecution(syntheticExecution());
  assert.ok(!fs.existsSync(rawFileFor(dir, 'firm.passports.permission')), 'no file for an execution with no observed pages');
});

test('append-only: re-preserving appends, never rewrites', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'RID' });
  p.preserveExecution(syntheticExecution());
  p.preserveExecution(syntheticExecution());
  assert.strictEqual(readLines(rawFileFor(dir, 'firm')).length, 2, 'second preserve appended a second line');
});

test('tally reflects attempts, preserved endpoints, pages, artefacts', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'RID' });
  const t = p.preserveExecution(syntheticExecution());
  assert.strictEqual(t.endpointsAttempted, 3);
  assert.strictEqual(t.endpointsPreserved, 2);
  assert.strictEqual(t.pagesPreserved, 2);
  assert.strictEqual(t.transportErrors, 0);
  assert.deepStrictEqual(t.artefacts.sort(), ['firm.ndjson', 'firm.permissions.ndjson']);
});

test('transport errors are tallied but the raw body is still preserved', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'RID' });
  const exec = {
    family: 'firm', anchor: '1', order: ['firm'],
    executions: [{ endpointId: 'firm', status: 'executed', pages: [{ requestUri: 'u', response: {
      errorType: 'CONNECTION_ERROR', httpStatus: null, requestUri: 'u', headers: null, rawBody: null, body: null, envelope: null,
    } }] }],
  };
  const t = p.preserveExecution(exec);
  assert.strictEqual(t.transportErrors, 1);
  assert.strictEqual(t.pagesPreserved, 1, 'the failed observation is still preserved as evidence');
});

test('no request credential is present in preserved lines', () => {
  const dir = tmp();
  const p = createPreserver(dir, { runId: 'RID' });
  p.preserveExecution(syntheticExecution());
  const raw = fs.readFileSync(rawFileFor(dir, 'firm'), 'utf8');
  assert.ok(!/x-auth-key/i.test(raw), 'no X-Auth-Key in preserved evidence');
  assert.ok(!/x-auth-email/i.test(raw), 'no X-Auth-Email in preserved evidence');
});
