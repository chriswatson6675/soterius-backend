'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const adapter = require('./index');
const { runBatchAdapter, validateCanonicalRecord } = require('../../batch-adapter-contract');
const { buildOdsBuffer } = require('./test-fixtures/build-ods');

const HEADERS = [
  'MLR Registration Number',
  'Business Start Date',
  'Business Name',
  'Agent Start Date',
  'Trading Name',
  'Postcode',
  'Money Service Businesses',
  'High Value Dealer',
  'Accountancy Service Provider',
  'Trust or Company Service Provider',
  'Estate Agency Business',
  'Status',
];

function row({
  reg = '12137104',
  businessStart = '01/06/2002',
  name = 'POST OFFICE LIMITED',
  agentStart = '01/06/2021',
  trading = 'ABBERLEY',
  postcode = 'WR6',
  msb = 'Yes',
  hvd = 'No Data',
  asp = 'No Data',
  tcsp = 'No Data',
  eab = 'No Data',
  status = 'APPROVED',
} = {}) {
  return [reg, businessStart, name, agentStart, trading, postcode, msb, hvd, asp, tcsp, eab, status];
}

test('conforms to the Batch Adapter Contract shape', () => {
  assert.equal(typeof adapter.sourceId, 'string');
  assert.ok(adapter.sourceId);
  assert.equal(typeof adapter.parse, 'function');
  assert.equal(typeof adapter.validateStructure, 'function');
  assert.equal(typeof adapter.normalise, 'function');
});

test('valid rows: emits one canonical record per row, conforming to the shared shape', async () => {
  const buf = await buildOdsBuffer({
    headers: HEADERS,
    rows: [row(), row({ reg: '99999999', name: 'ACME ACCOUNTANTS LTD', trading: '', postcode: 'SW1A' })],
  });

  const result = await runBatchAdapter(adapter, buf, { sourceDate: '2026-07-13' });

  assert.equal(result.fatalError, null);
  assert.equal(result.stage, 'complete');
  assert.equal(result.rowsParsed, 2);
  assert.equal(result.rowsRejected, 0);
  assert.equal(result.recordsEmitted, 2);
  for (const record of result.records) {
    assert.deepEqual(validateCanonicalRecord(record, 0), []);
  }
  assert.equal(result.records[0].name, 'POST OFFICE LIMITED');
  assert.equal(result.records[0].source, 'hmrc-aml');
  assert.equal(result.records[0].regulator, 'HMRC');
  assert.equal(result.records[0].noDomainAsserted, true);
  assert.equal(result.records[0].domainRaw, null);
  assert.equal(result.records[0].hmrcAml, '12137104');
  assert.equal(result.records[0].sourceDate, '2026-07-13');
  assert.equal(result.records[1].hmrcAml, '99999999');
});

test('missing fields: a blank Business Name is a structural rejection', async () => {
  const buf = await buildOdsBuffer({
    headers: HEADERS,
    rows: [row({ name: '' })],
  });

  const result = await runBatchAdapter(adapter, buf);

  assert.equal(result.recordsEmitted, 0);
  assert.equal(result.rowsRejected, 1);
  assert.equal(result.rejections[0].stage, 'validateStructure');
  assert.match(result.rejections[0].reason, /Business Name/);
});

test('missing fields: a blank MLR registration number is preserved as a null anchor, not rejected', async () => {
  const buf = await buildOdsBuffer({
    headers: HEADERS,
    rows: [row({ reg: '' })],
  });

  const result = await runBatchAdapter(adapter, buf);

  assert.equal(result.rowsRejected, 0);
  assert.equal(result.recordsEmitted, 1);
  assert.equal(result.records[0].hmrcAml, null);
  assert.equal(result.records[0].name, 'POST OFFICE LIMITED');
  assert.match(result.records[0].provenance.key, /^ROW:/);
});

test('duplicate identifiers: the same MLR registration number recurring across rows (branch addresses) is expected source structure, not deduplicated or rejected', async () => {
  const buf = await buildOdsBuffer({
    headers: HEADERS,
    rows: [
      row({ trading: 'ABBERLEY', postcode: 'WR6' }),
      row({ trading: 'ABBEY FOREGATE', postcode: 'SY2' }),
      row({ trading: 'ABBEY LANE', postcode: 'S8' }),
    ],
  });

  const result = await runBatchAdapter(adapter, buf);

  assert.equal(result.recordsEmitted, 3);
  assert.deepEqual(
    result.records.map((r) => r.hmrcAml),
    ['12137104', '12137104', '12137104']
  );
  // Each branch row still gets its own distinct, traceable provenance key.
  const keys = result.records.map((r) => r.provenance.key);
  assert.equal(new Set(keys).size, 3);
});

test('malformed rows: a row with neither a usable name nor anchor is rejected, never fabricated', async () => {
  const buf = await buildOdsBuffer({
    headers: HEADERS,
    rows: [row({ reg: '', name: '' })],
  });

  const result = await runBatchAdapter(adapter, buf);

  assert.equal(result.recordsEmitted, 0);
  assert.equal(result.rowsRejected, 1);
});

test('malformed input: a non-ODS buffer fails at the parse stage as a fatal, non-throwing error', async () => {
  const result = await runBatchAdapter(adapter, Buffer.from('this is not a zip file at all'));

  assert.equal(result.stage, 'parse');
  assert.ok(result.fatalError);
  assert.equal(result.fatalError.stage, 'parse');
  assert.equal(result.recordsEmitted, 0);
  assert.equal(result.records.length, 0);
});

test('malformed input: an ODS file missing the required register columns fails at the parse stage', async () => {
  const buf = await buildOdsBuffer({
    headers: ['Some Other Column', 'Another Column'],
    rows: [['a', 'b']],
  });

  const result = await runBatchAdapter(adapter, buf);

  assert.equal(result.stage, 'parse');
  assert.ok(result.fatalError);
  assert.match(result.fatalError.message, /missing required column/);
});

test('never asserts a domain: HMRC AML publishes no website (ACQ-014 §8)', async () => {
  const buf = await buildOdsBuffer({ headers: HEADERS, rows: [row()] });
  const result = await runBatchAdapter(adapter, buf);

  assert.equal(result.records[0].domainRaw, null);
  assert.equal(result.records[0].domainSource, null);
  assert.equal(result.records[0].domainPriority, null);
  assert.equal(result.records[0].noDomainAsserted, true);
});

test('never performs identity resolution: no companyNumber, frn, sraNumber, lei, or ukprn is invented', async () => {
  const buf = await buildOdsBuffer({ headers: HEADERS, rows: [row()] });
  const result = await runBatchAdapter(adapter, buf);

  const record = result.records[0];
  assert.equal(record.companyNumber, null);
  assert.equal(record.frn, null);
  assert.equal(record.sraNumber, null);
  assert.equal(record.lei, null);
  assert.equal(record.ukprn, null);
  assert.equal(record.ifUuid, null);
});
