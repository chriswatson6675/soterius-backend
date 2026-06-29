'use strict';

// resume.test.js — Phase 7 resume tests (IMP-FCA-001 §7).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { inspectRun, planResume, resumeCollection } = require('./resume');

const BASE = 'https://register.fca.org.uk/services/V0.1';
const CONFIG = { baseUrl: BASE, email: 'e@x', apiKey: 'k' };

function tmpRun() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fca-resume-')); fs.mkdirSync(path.join(d, 'raw'), { recursive: true }); return d; }

/** Append a preserved raw line as Phase 4 would. */
function writeRaw(dir, endpointId, { transport = 'NONE', next = null, body = { Data: [{}] }, dependencyId = null } = {}) {
  const line = {
    runId: 'RID', family: 'firm', anchor: '1', endpointId, dependencyId, pageSequence: 1,
    requestUri: `${BASE}/${endpointId}`, collectionTimestamp: 'T', transport, httpStatus: transport === 'NONE' ? 200 : null,
    responseHeaders: {}, fcaEnvelope: { status: 'FSR-API-XX', message: null, resultInfo: next ? { Next: next } : {} },
    rawBody: transport === 'NONE' ? JSON.stringify(body) : null, attempts: null,
  };
  fs.appendFileSync(path.join(dir, 'raw', `${endpointId}.ndjson`), JSON.stringify(line) + '\n');
}

function routedFetch(routes) {
  const calls = [];
  return { calls, fetchFn: async (url) => {
    calls.push(url);
    const body = routes[url] !== undefined ? routes[url] : (Object.entries(routes).find(([k]) => url.startsWith(k)) || [])[1];
    if (body === undefined) return { statusCode: 200, headers: {}, bodyBuffer: Buffer.from(JSON.stringify({ Status: 'X-22', Data: null })) };
    return { statusCode: 200, headers: { 'content-type': 'application/json' }, bodyBuffer: Buffer.from(JSON.stringify(body)) };
  } };
}

test('inspectRun: complete vs incomplete (mid-pagination) vs failed', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm.address');                                  // complete (no Next)
  writeRaw(dir, 'firm.names', { next: `${BASE}/Firm/1/Names?pgnp=2` }); // incomplete (has Next)
  writeRaw(dir, 'firm.regulators', { transport: 'CONNECTION_ERROR' });  // failed, never succeeded
  const s = inspectRun(dir);
  assert.strictEqual(s['firm.address'].groups['-'].complete, true);
  assert.strictEqual(s['firm.names'].groups['-'].complete, false);
  assert.strictEqual(s['firm.names'].groups['-'].resumeNext, `${BASE}/Firm/1/Names?pgnp=2`);
  assert.strictEqual(s['firm.regulators'].groups['-'].complete, false);
  assert.strictEqual(s['firm.regulators'].groups['-'].successCount, 0);
});

test('planResume: skip complete, continue paginated, observe-fresh missing/failed', () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm');                                   // complete
  writeRaw(dir, 'firm.names', { next: `${BASE}/Firm/1/Names?pgnp=2` }); // continue
  writeRaw(dir, 'firm.regulators', { transport: 'TIMEOUT' });          // observe-fresh (failed)
  const plan = planResume(dir, 'firm', ['firm', 'firm.names', 'firm.address', 'firm.regulators']);
  const byId = Object.fromEntries(plan.map((p) => [p.endpointId, p]));
  assert.strictEqual(byId['firm'].action, 'skip');
  assert.strictEqual(byId['firm.names'].action, 'continue');
  assert.strictEqual(byId['firm.names'].startUrl, `${BASE}/Firm/1/Names?pgnp=2`);
  assert.strictEqual(byId['firm.address'].action, 'observe-fresh'); // missing
  assert.strictEqual(byId['firm.regulators'].action, 'observe-fresh'); // failed
});

test('resumeCollection: skips complete, observes missing, continues pagination — no duplicates', async () => {
  const dir = tmpRun();
  // firm complete; firm.address missing; firm.names interrupted at page 1 with Next → page 2.
  writeRaw(dir, 'firm');
  writeRaw(dir, 'firm.names', { next: `${BASE}/Firm/1/Names?pgnp=2`, body: { Data: [{ 'Current Names': [] }] } });
  const { fetchFn, calls } = routedFetch({
    [`${BASE}/Firm/1/Address`]: { Status: 'FSR-API-02-02-00', Data: [{ 'Website Address': 'x' }] },
    [`${BASE}/Firm/1/Names?pgnp=2`]: { Status: 'FSR-API-02-04-00', ResultInfo: {}, Data: [{}] }, // final page
  });

  const summary = await resumeCollection(dir, { family: 'firm', anchor: '1', scope: ['firm', 'firm.names', 'firm.address'], config: CONFIG, runId: 'RID', _fetch: fetchFn });

  assert.deepStrictEqual(summary.skipped, ['firm']);            // complete → skipped, NOT re-fetched
  assert.deepStrictEqual(summary.observed, ['firm.address']);   // missing → observed
  assert.deepStrictEqual(summary.continued, ['firm.names']);    // continued from Next
  assert.ok(!calls.some((u) => u === `${BASE}/Firm/1`), 'completed firm endpoint was not re-fetched (no duplicate)');
  assert.ok(calls.includes(`${BASE}/Firm/1/Names?pgnp=2`), 'continued from the saved Next');

  // firm.address now has exactly one preserved line; firm.names now has 2 (page1 + continued page2).
  const namesLines = fs.readFileSync(path.join(dir, 'raw', 'firm.names.ndjson'), 'utf8').trim().split('\n').length;
  assert.strictEqual(namesLines, 2, 'continuation appended page 2 only (no duplicate of page 1)');
});

test('resumeCollection does not overwrite a completed endpoint line', async () => {
  const dir = tmpRun();
  writeRaw(dir, 'firm');
  const before = fs.readFileSync(path.join(dir, 'raw', 'firm.ndjson'), 'utf8');
  await resumeCollection(dir, { family: 'firm', anchor: '1', scope: ['firm'], config: CONFIG, runId: 'RID', _fetch: routedFetch({}).fetchFn });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'raw', 'firm.ndjson'), 'utf8'), before);
});
