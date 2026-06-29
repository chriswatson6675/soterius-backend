'use strict';

// extract-map.test.js — Phase 5 enumerator tests (IMP-FCA-001 §5).

const { test } = require('node:test');
const assert = require('node:assert');
const { enumerate, getByPath, pathToString } = require('./extract-map');

test('single: one item per Data element with Data[i] path', () => {
  const body = { Data: [{ FRN: '1', 'Address LIne 3': '' }] };
  const { items } = enumerate('single', body, 'firm');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].jsonPath, 'Data[0]');
  assert.deepStrictEqual(items[0].value, { FRN: '1', 'Address LIne 3': '' });
  assert.deepStrictEqual(getByPath(body, items[0].path), items[0].value);
});

test('list: one item per element; null Data → zero items (observed absence)', () => {
  const { items } = enumerate('list', { Data: [{ a: 1 }, { b: 2 }] }, 'firm.regulators');
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[1].jsonPath, 'Data[1]');
  const empty = enumerate('list', { Data: null }, 'firm.requirements.investmentTypes');
  assert.deepStrictEqual(empty.items, []);
});

test('names: enumerates current/previous container keys verbatim', () => {
  const body = { Data: [{ 'Current Names': [{ Name: 'A' }, { Name: 'B' }] }, { 'Previous Names': [{ Name: 'C' }] }] };
  const { items } = enumerate('names', body, 'firm.names');
  assert.strictEqual(items.length, 3);
  assert.strictEqual(items[0].jsonPath, 'Data[0]["Current Names"][0]');
  assert.strictEqual(items[0].key, 'Current Names');
  assert.strictEqual(items[2].key, 'Previous Names');
  assert.deepStrictEqual(getByPath(body, items[0].path), { Name: 'A' });
});

test('dynamic-map: one item per activity key, key preserved, value verbatim', () => {
  const body = { Data: { 'Accepting Deposits': [{ 'Customer Type': ['Customer'] }], 'Debt Adjusting': [{ Limitation: ['x'] }] } };
  const { items } = enumerate('dynamic-map', body, 'firm.permissions');
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].key, 'Accepting Deposits');
  assert.strictEqual(items[0].jsonPath, 'Data["Accepting Deposits"]');
  assert.deepStrictEqual(getByPath(body, items[0].path), [{ 'Customer Type': ['Customer'] }]);
});

test('dynamic-map-cf: Current/Previous role keys enumerated', () => {
  const body = { Data: [{ Current: { '(6)SMF7 X': { Name: 'SMF7 X' } }, Previous: { '(1)CF30 Y': { Name: 'CF30 Y', 'End Date': '01/01/2020' } } }] };
  const { items } = enumerate('dynamic-map-cf', body, 'firm.cf');
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].key, '(6)SMF7 X');
  assert.strictEqual(items[0].jsonPath, 'Data[0]["Current"]["(6)SMF7 X"]');
  assert.strictEqual(items[1].value['End Date'], '01/01/2020');
});

test('ar: current + previous arrays enumerated with their list key', () => {
  const body = { Data: { CurrentAppointedRepresentatives: null, PreviousAppointedRepresentatives: [{ FRN: '496326' }] } };
  const { items } = enumerate('ar', body, 'firm.ar');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].key, 'PreviousAppointedRepresentatives');
  assert.strictEqual(items[0].jsonPath, 'Data["PreviousAppointedRepresentatives"][0]');
});

test('passports: nested Passports array enumerated', () => {
  const body = { Data: [{ Passports: [{ Country: 'GIBRALTAR' }] }] };
  const { items } = enumerate('passports', body, 'firm.passports');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].jsonPath, 'Data[0]["Passports"][0]');
});

test('null Data (absence / pagination-tail page) → zero items for any responseType', () => {
  for (const rt of ['single', 'names', 'dynamic-map', 'dynamic-map-cf', 'ar', 'passports', 'list']) {
    assert.deepStrictEqual(enumerate(rt, { Status: 'FSR-API-02-04-22', Data: null }, 'firm.names').items, [], `${rt} on null Data`);
  }
});

test('unrecognised shape → single fallback item over Data + flag (no loss)', () => {
  const body = { Data: { unexpected: true } };
  const out = enumerate('single', body, 'firm'); // single expects an array
  assert.strictEqual(out.unrecognised, true);
  assert.strictEqual(out.items.length, 1);
  assert.strictEqual(out.items[0].unrecognised, true);
  assert.deepStrictEqual(out.items[0].value, { unexpected: true });
});

test('pathToString quotes string keys and brackets indices', () => {
  assert.strictEqual(pathToString(['Data', 0, 'Current Names', 2]), 'Data[0]["Current Names"][2]');
});
