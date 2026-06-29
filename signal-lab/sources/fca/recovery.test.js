'use strict';

// recovery.test.js — Phase 7 recovery tests (IMP-FCA-001 §7).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeManifest, buildManifest } = require('./manifest');
const { recoverRun, isComplete } = require('./recovery');

const BASE = 'https://register.fca.org.uk/services/V0.1';
const CONFIG = { baseUrl: BASE, email: 'e@x', apiKey: 'k' };

function tmpRun() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fca-recover-')); fs.mkdirSync(path.join(d, 'raw'), { recursive: true }); return d; }
function writeRaw(dir, endpointId, body = { Data: [{}] }) {
  const line = { runId: 'RID', family: 'firm', anchor: '1', endpointId, dependencyId: null, pageSequence: 1,
    requestUri: `${BASE}/${endpointId}`, collectionTimestamp: 'T', transport: 'NONE', httpStatus: 200,
    responseHeaders: {}, fcaEnvelope: { status: 'X', resultInfo: {} }, rawBody: JSON.stringify(body), attempts: null };
  fs.appendFileSync(path.join(dir, 'raw', `${endpointId}.ndjson`), JSON.stringify(line) + '\n');
}
function routedFetch(routes) {
  const calls = [];
  return { calls, fetchFn: async (url) => {
    calls.push(url);
    const body = routes[url] !== undefined ? routes[url] : (Object.entries(routes).find(([k]) => url.startsWith(k)) || [])[1];
    if (body === undefined) return { statusCode: 200, headers: {}, bodyBuffer: Buffer.from(JSON.stringify({ Status: 'X-22', Data: null })) };
    return { statusCode: 200, headers: {}, bodyBuffer: Buffer.from(JSON.stringify(body)) };
  } };
}

test('recoverRun: resumes remaining endpoints, leaves preserved ones untouched, records resume history', async () => {
  const dir = tmpRun();
  const scope = ['firm', 'firm.address', 'firm.regulators'];
  writeRaw(dir, 'firm'); // already preserved
  writeManifest(dir, buildManifest({ runId: 'RID', collectorVersion: 'v', apiVersion: 'V0.1', family: 'firm', anchor: '1', scope }, { endpointsAttempted: 1, endpointsPreserved: 1, pagesPreserved: 1, transportErrors: 0, artefacts: ['firm.ndjson'] }));

  const firmBefore = fs.readFileSync(path.join(dir, 'raw', 'firm.ndjson'), 'utf8');
  const { fetchFn, calls } = routedFetch({
    [`${BASE}/Firm/1/Address`]: { Status: 'A', ResultInfo: {}, Data: [{ 'Website Address': 'x' }] },
    [`${BASE}/Firm/1/Regulators`]: { Status: 'R', ResultInfo: {}, Data: [{ 'Regulator Name': 'FCA' }] },
  });

  const { summary, manifest, alreadyComplete } = await recoverRun(dir, { config: CONFIG, _fetch: fetchFn, now: () => '2026-06-29T12:00:00Z' });

  assert.strictEqual(alreadyComplete, false);
  assert.deepStrictEqual(summary.skipped, ['firm']);
  assert.deepStrictEqual(summary.observed.sort(), ['firm.address', 'firm.regulators']);
  assert.ok(!calls.some((u) => u === `${BASE}/Firm/1`), 'preserved firm not re-fetched');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'raw', 'firm.ndjson'), 'utf8'), firmBefore, 'preserved evidence unchanged');
  assert.ok(manifest.resumeHistory.length === 1, 'resume history recorded');
  assert.strictEqual(manifest.endpointsPreserved, 3, 'manifest tallies refreshed');
});

test('recoverRun is idempotent: a complete run does nothing on re-recover', async () => {
  const dir = tmpRun();
  const scope = ['firm', 'firm.address'];
  writeRaw(dir, 'firm'); writeRaw(dir, 'firm.address');
  writeManifest(dir, buildManifest({ runId: 'RID', collectorVersion: 'v', apiVersion: 'V0.1', family: 'firm', anchor: '1', scope }, { endpointsAttempted: 2, endpointsPreserved: 2, pagesPreserved: 2, transportErrors: 0, artefacts: [] }));

  assert.strictEqual(isComplete(dir, 'firm', scope), true);
  const before = fs.readFileSync(path.join(dir, 'raw', 'firm.address.ndjson'), 'utf8');
  const { alreadyComplete, summary } = await recoverRun(dir, { config: CONFIG, _fetch: routedFetch({}).fetchFn });
  assert.strictEqual(alreadyComplete, true);
  assert.strictEqual(summary.newPages, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'raw', 'firm.address.ndjson'), 'utf8'), before);
});
