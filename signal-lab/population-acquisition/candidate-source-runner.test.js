'use strict';

// candidate-source-runner.test.js — sequential orchestration over an injected source.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCandidateSource } = require('./candidate-source-runner');
const { createFcaSearch, createFcaEnrich, createRegistryPersist } = require('./fca-adapters');
const { openLedger } = require('./processing-ledger');

const cand = (n) => ({ companyNumber: String(n), companyName: `Firm ${n}` });

test('rejects a non-iterable source', async () => {
  await assert.rejects(runCandidateSource(42, {}), /iterable/);
});

test('empty source → zero processed, empty results/counts, not stopped', async () => {
  const r = await runCandidateSource([], {}, { process: async () => ({ outcome: 'acquired' }) });
  assert.deepStrictEqual({ processed: r.processed, results: r.results, counts: r.counts, stopped: r.stopped }, { processed: 0, results: [], counts: {}, stopped: false });
});

test('multiple successful candidates → all acquired; processor called once per candidate', async () => {
  let calls = 0;
  const process = async (c) => { calls++; return { companyNumber: c.companyNumber, outcome: 'acquired' }; };
  const r = await runCandidateSource([cand(1), cand(2), cand(3)], {}, { process });
  assert.strictEqual(r.processed, 3);
  assert.strictEqual(calls, 3, 'one call per yielded candidate');
  assert.deepStrictEqual(r.counts, { acquired: 3 });
});

test('mixed outcomes are recorded and all processed (continue on recoverable outcomes)', async () => {
  const plan = { 1: 'acquired', 2: 'discarded', 3: 'no_match', 4: 'ambiguous', 5: 'already_claimed', 6: 'failed' };
  const process = async (c) => ({ companyNumber: c.companyNumber, outcome: plan[c.companyNumber] });
  const r = await runCandidateSource([1, 2, 3, 4, 5, 6].map(cand), {}, { process });
  assert.strictEqual(r.processed, 6);
  assert.strictEqual(r.stopped, false);
  assert.deepStrictEqual(r.counts, { acquired: 1, discarded: 1, no_match: 1, ambiguous: 1, already_claimed: 1, failed: 1 });
});

test('processor throw (unrecoverable) stops the run; later candidates are not processed', async () => {
  const seen = [];
  const process = async (c) => {
    seen.push(c.companyNumber);
    if (c.companyNumber === '2') throw new Error('invalid transition: claimed → complete');
    return { companyNumber: c.companyNumber, outcome: 'acquired' };
  };
  const r = await runCandidateSource([cand(1), cand(2), cand(3)], {}, { process });
  assert.strictEqual(r.stopped, true);
  assert.match(r.error, /invalid transition/);
  assert.strictEqual(r.stoppedCandidate.companyNumber, '2');
  assert.strictEqual(r.processed, 1, 'only candidate 1 produced an outcome');
  assert.deepStrictEqual(seen, ['1', '2'], 'candidate 3 was never processed');
});

test('processing is strictly sequential (one at a time, in source order)', async () => {
  let active = 0; const order = [];
  const process = async (c) => {
    assert.strictEqual(active, 0, 'no overlapping processing');
    active++;
    await new Promise((res) => setImmediate(res));   // yield the event loop
    order.push(c.companyNumber);
    active--;
    return { outcome: 'acquired' };
  };
  await runCandidateSource([cand(1), cand(2), cand(3)], {}, { process });
  assert.deepStrictEqual(order, ['1', '2', '3']);
});

test('source-agnostic: consumes an async generator', async () => {
  async function* gen() { yield cand(1); yield cand(2); }
  const r = await runCandidateSource(gen(), {}, { process: async () => ({ outcome: 'acquired' }) });
  assert.strictEqual(r.processed, 2);
  assert.deepStrictEqual(r.counts, { acquired: 2 });
});

test('integration: runs a small source through the REAL processor + adapters + ledger', async () => {
  function okBody(o) { return { statusCode: 200, headers: {}, bodyBuffer: Buffer.from(JSON.stringify(o)) }; }
  const _fetch = async (url) => {
    if (/\/Search\?q=DENNEHY/.test(url)) return okBody({ Data: [{ 'Reference Number': '114360', Name: 'Dennehy Wealth Limited', Status: 'Authorised' }] });
    if (/\/Search\?q=NOMATCH/.test(url)) return okBody({ Data: null });
    if (/\/Firm\/114360\/Address/.test(url)) return okBody({ Data: [{ 'Website Address': 'dennehywealth.co.uk' }] });
    if (/\/Firm\/114360\/Permissions/.test(url)) return okBody({ Data: { 'Advising on investments': [{}] } });
    if (/\/Firm\/114360$/.test(url)) return okBody({ Data: [{ 'Organisation Name': 'Dennehy Wealth Limited' }] });
    return okBody({ Data: null });
  };
  const CONFIG = { baseUrl: 'https://reg.example.test/V0.1', email: 'o@e.test', apiKey: 'K' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-run-'));
  const deps = {
    ledger: openLedger({ path: path.join(dir, 'ledger.ndjson'), now: (() => { let t = 0; return () => new Date(t += 1000); })() }),
    fcaSearch: createFcaSearch({ config: CONFIG, _fetch }),
    fcaEnrich: createFcaEnrich({ config: CONFIG, _fetch }),
    persist: createRegistryPersist({ path: path.join(dir, 'registry.ndjson'), now: () => new Date(0) }),
  };
  const source = [
    { companyNumber: '09623642', companyName: 'DENNEHY WEALTH LIMITED' }, // → acquired
    { companyNumber: 'Q1', companyName: 'NOMATCH CO LIMITED' },           // → no_match
    { companyNumber: '09623642', companyName: 'DENNEHY WEALTH LIMITED' }, // → already_claimed (dup)
  ];
  const r = await runCandidateSource(source, deps);
  assert.strictEqual(r.processed, 3);
  assert.deepStrictEqual(r.counts, { acquired: 1, no_match: 1, already_claimed: 1 });
  const registry = fs.readFileSync(path.join(dir, 'registry.ndjson'), 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(registry.length, 1, 'exactly one organisation persisted');
  assert.strictEqual(JSON.parse(registry[0]).frn, '114360');
});
