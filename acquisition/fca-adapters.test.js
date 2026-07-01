'use strict';

// fca-adapters.test.js — infrastructure adapters over the real fca-client (stubbed transport).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFcaSearch, createFcaEnrich, createRegistryPersist } = require('./fca-adapters');
const { processCandidate, PROCESS_OUTCOME } = require('./candidate-processor');
const { openLedger } = require('./processing-ledger');
const { STATES } = require('./processing-state');

const CONFIG = { baseUrl: 'https://register.example.test/services/V0.1', email: 'o@e.test', apiKey: 'K' };

// fca-client transport stub contract: fetchFn(url, opts) → { statusCode, headers, bodyBuffer } | { error }
function okBody(obj) { return { statusCode: 200, headers: { 'content-type': 'application/json' }, bodyBuffer: Buffer.from(JSON.stringify(obj)) }; }
function routeFetch(routes) {
  return async (url) => {
    for (const [re, resp] of routes) if (re.test(url)) return typeof resp === 'function' ? resp(url) : resp;
    return { statusCode: 404, headers: {}, bodyBuffer: Buffer.from('{}') };
  };
}
function tmp(name) { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-adapt-')), name); }

// ── Search adapter ──
test('fcaSearch maps FCA hits to {frn,name,status}; performs no filtering', async () => {
  const _fetch = routeFetch([[/\/Search\?/, okBody({ Status: 'FSR-API-04-01-00', Data: [
    { 'Reference Number': '114360', Name: 'Dennehy Wealth Ltd (Postcode: X)', Status: 'Authorised' },
    { 'Reference Number': '999', Name: 'Other Ltd', Status: 'Appointed representative' },
  ] })]]);
  const search = createFcaSearch({ config: CONFIG, _fetch });
  const out = await search('DENNEHY WEALTH LIMITED');
  assert.deepStrictEqual(out, [
    { frn: '114360', name: 'Dennehy Wealth Ltd (Postcode: X)', status: 'Authorised' },
    { frn: '999', name: 'Other Ltd', status: 'Appointed representative' },
  ]);
});

test('fcaSearch returns [] on a "no results" success (null Data)', async () => {
  const _fetch = routeFetch([[/\/Search\?/, okBody({ Status: 'FSR-API-04-01-11', Message: 'No search result found', Data: null })]]);
  const search = createFcaSearch({ config: CONFIG, _fetch });
  assert.deepStrictEqual(await search('NOTHING LTD'), []);
});

test('fcaSearch throws (propagates) on a transport/HTTP error', async () => {
  const _fetch = routeFetch([[/\/Search\?/, { statusCode: 500, headers: {}, bodyBuffer: Buffer.from('err') }]]);
  const search = createFcaSearch({ config: CONFIG, _fetch });
  await assert.rejects(search('X'), /FCA search failed/);
});

// ── Enrichment adapter ──
test('fcaEnrich returns raw Data for the registry endpoints, unchanged', async () => {
  const _fetch = routeFetch([
    [/\/Firm\/114360\/Address/, okBody({ Data: [{ 'Website Address': 'dennehywealth.co.uk' }] })],
    [/\/Firm\/114360\/Permissions/, okBody({ Data: { 'Advising on investments': [{}] } })],
    [/\/Firm\/114360$/, okBody({ Data: [{ 'Organisation Name': 'Dennehy Wealth Limited' }] })],
  ]);
  const enrich = createFcaEnrich({ config: CONFIG, _fetch });
  const out = await enrich('114360');
  assert.strictEqual(out.frn, '114360');
  assert.deepStrictEqual(out['firm'], [{ 'Organisation Name': 'Dennehy Wealth Limited' }]);
  assert.deepStrictEqual(out['firm.address'], [{ 'Website Address': 'dennehywealth.co.uk' }]);
  assert.deepStrictEqual(out['firm.permissions'], { 'Advising on investments': [{}] });
});

test('fcaEnrich throws (propagates) if any endpoint errors', async () => {
  const _fetch = routeFetch([
    [/\/Firm\/55$/, okBody({ Data: [{}] })],
    [/\/Firm\/55\/Address/, { statusCode: 503, headers: {}, bodyBuffer: Buffer.from('x') }],
  ]);
  const enrich = createFcaEnrich({ config: CONFIG, _fetch });
  await assert.rejects(enrich('55'), /FCA enrich firm\.address failed/);
});

// ── Registry adapter ──
test('registry persist appends an acquired record and returns the result; no lifecycle logic', async () => {
  const file = tmp('registry.ndjson');
  const persist = createRegistryPersist({ path: file, now: () => new Date(0) });
  const res = await persist({ companyNumber: '09623642', frn: '114360', firm: [{}] });
  assert.deepStrictEqual(res, { persisted: true, companyNumber: '09623642', frn: '114360' });
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(JSON.parse(lines[0]).frn, '114360');
});

test('registry persist propagates write errors (no swallow)', async () => {
  const file = tmp('registry.ndjson');
  const persist = createRegistryPersist({ path: file });
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);                              // make the target a directory → appendFileSync must fail
  await assert.rejects(persist({ companyNumber: 'X', frn: '1' }));
});

test('createRegistryPersist requires a path', () => {
  assert.throws(() => createRegistryPersist({}), /requires a path/);
});

// ── Integration with the real Candidate Processor + real ledger ──
test('adapters integrate with processCandidate for a real authorised acquisition', async () => {
  const _fetch = routeFetch([
    [/\/Search\?/, okBody({ Data: [{ 'Reference Number': '114360', Name: 'Dennehy Wealth Limited', Status: 'Authorised' }] })],
    [/\/Firm\/114360\/Address/, okBody({ Data: [{ 'Website Address': 'dennehywealth.co.uk' }] })],
    [/\/Firm\/114360\/Permissions/, okBody({ Data: { 'Advising on investments': [{}] } })],
    [/\/Firm\/114360$/, okBody({ Data: [{ 'Organisation Name': 'Dennehy Wealth Limited' }] })],
  ]);
  const ledgerFile = tmp('ledger.ndjson');
  const registryFile = tmp('registry.ndjson');
  const deps = {
    ledger: openLedger({ path: ledgerFile, now: (() => { let t = 0; return () => new Date(t += 1000); })() }),
    fcaSearch: createFcaSearch({ config: CONFIG, _fetch }),
    fcaEnrich: createFcaEnrich({ config: CONFIG, _fetch }),
    persist: createRegistryPersist({ path: registryFile, now: () => new Date(0) }),
  };

  const r = await processCandidate({ companyNumber: '09623642', companyName: 'DENNEHY WEALTH LIMITED' }, deps);
  assert.strictEqual(r.outcome, PROCESS_OUTCOME.ACQUIRED);
  assert.strictEqual(r.state, STATES.COMPLETE);
  assert.strictEqual(r.frn, '114360');
  assert.strictEqual(deps.ledger.getState('09623642'), STATES.COMPLETE);

  const persisted = JSON.parse(fs.readFileSync(registryFile, 'utf8').split('\n').filter(Boolean)[0]);
  assert.strictEqual(persisted.companyNumber, '09623642');
  assert.strictEqual(persisted.frn, '114360');
  assert.deepStrictEqual(persisted['firm.address'], [{ 'Website Address': 'dennehywealth.co.uk' }]);
});
