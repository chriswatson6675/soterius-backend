'use strict';

// companies-house-source.test.js — streaming CH candidate selection.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { companiesHouseCandidateSource, streamBulkCsv, parseCsvLine } = require('./companies-house-source');
const { runCandidateSource } = require('./candidate-source-runner');

async function collect(it) { const out = []; for await (const x of it) out.push(x); return out; }
const rec = (companyNumber, companyName, status, sicCodes) => ({ companyNumber, companyName, status, sicCodes });

test('valid financial active companies are yielded with the correct structure', async () => {
  const records = [
    rec('09623642', 'Dennehy Wealth Limited', 'Active', ['66190 - Activities auxiliary to financial intermediation n.e.c.']),
    rec('00111111', 'Some Insurer Plc', 'Active', ['65110 - Life insurance', '70229 - Management consultancy']),
  ];
  const out = await collect(companiesHouseCandidateSource({ records }));
  assert.deepStrictEqual(out, [
    { companyNumber: '09623642', companyName: 'Dennehy Wealth Limited', sicCodes: ['66190'] },
    { companyNumber: '00111111', companyName: 'Some Insurer Plc', sicCodes: ['65110'] },
  ]);
});

test('non-matching SIC codes are excluded (delegated to candidate-sic)', async () => {
  const records = [
    rec('1', 'Holdco Ltd', 'Active', ['64205 - Activities of financial services holding companies']), // excluded
    rec('2', 'Consultancy Ltd', 'Active', ['70229 - Management consultancy']),                          // excluded
  ];
  assert.deepStrictEqual(await collect(companiesHouseCandidateSource({ records })), []);
});

test('inactive companies are skipped by default; includable via activeOnly:false', async () => {
  const records = [rec('3', 'Dead Finance Ltd', 'Dissolved', ['66300 - Fund management activities'])];
  assert.deepStrictEqual(await collect(companiesHouseCandidateSource({ records })), []);
  const incl = await collect(companiesHouseCandidateSource({ records, activeOnly: false }));
  assert.deepStrictEqual(incl, [{ companyNumber: '3', companyName: 'Dead Finance Ltd', sicCodes: ['66300'] }]);
});

test('company number is coerced to string; multiple approved SICs deduped', async () => {
  const records = [rec(778899, 'Multi SIC Ltd', 'Active', ['66220 - insurance agents', '66220 - dup', '66300 - fund mgmt'])];
  const out = await collect(companiesHouseCandidateSource({ records }));
  assert.deepStrictEqual(out, [{ companyNumber: '778899', companyName: 'Multi SIC Ltd', sicCodes: ['66220', '66300'] }]);
});

test('streams lazily — an infinite record source is consumed incrementally, not buffered', async () => {
  let produced = 0;
  async function* infinite() { while (true) { produced++; yield rec(String(produced), `Firm ${produced}`, 'Active', ['66190']); } }
  const src = companiesHouseCandidateSource({ records: infinite() });
  const got = [];
  for await (const c of src) { got.push(c); if (got.length === 3) break; }   // early break proves no full buffering
  assert.strictEqual(got.length, 3);
  assert.ok(produced < 50, `source produced only what was consumed (${produced}), not the whole infinite stream`);
});

test('streamBulkCsv parses the CH bulk CSV (quoted comma names) and streams records', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-bulk-')), 'data.csv');
  fs.writeFileSync(file,
    'CompanyName,CompanyNumber,CompanyCategory,CompanyStatus,SICCode.SicText_1,SICCode.SicText_2\n' +
    '"DENNEHY WEALTH, LIMITED",09623642,ltd,Active,"66190 - Activities auxiliary to financial intermediation n.e.c.",\n' +
    'HOLDCO LIMITED,01000001,ltd,Active,"64205 - Activities of financial services holding companies",\n' +
    'DEAD FINANCE LIMITED,01000002,ltd,Dissolved,"66300 - Fund management activities",\n');

  const raw = await collect(streamBulkCsv(file));
  assert.strictEqual(raw.length, 3);
  assert.deepStrictEqual(raw[0], { companyName: 'DENNEHY WEALTH, LIMITED', companyNumber: '09623642', status: 'Active', sicCodes: ['66190 - Activities auxiliary to financial intermediation n.e.c.'] });

  // through the candidate filter: only the active financial company survives
  const candidates = await collect(companiesHouseCandidateSource({ path: file }));
  assert.deepStrictEqual(candidates, [{ companyNumber: '09623642', companyName: 'DENNEHY WEALTH, LIMITED', sicCodes: ['66190'] }]);
});

test('parseCsvLine handles quotes, escaped quotes and empty trailing field', () => {
  assert.deepStrictEqual(parseCsvLine('"a, b",c,'), ['a, b', 'c', '']);
  assert.deepStrictEqual(parseCsvLine('"he said ""hi""",x'), ['he said "hi"', 'x']);
});

test('integrates with the Candidate Source Runner', async () => {
  const records = [
    rec('A', 'Wealth Ltd', 'Active', ['66190 - aux']),     // candidate
    rec('B', 'Holdco Ltd', 'Active', ['64205 - holding']), // excluded
    rec('C', 'Broker Ltd', 'Active', ['66220 - brokers']), // candidate
  ];
  let seen = [];
  const r = await runCandidateSource(
    companiesHouseCandidateSource({ records }),
    {},
    { process: async (c) => { seen.push(c.companyNumber); return { outcome: 'no_match' }; } },
  );
  assert.strictEqual(r.processed, 2, 'only the two financial candidates reached the runner');
  assert.deepStrictEqual(seen, ['A', 'C']);
  assert.deepStrictEqual(r.counts, { no_match: 2 });
});
