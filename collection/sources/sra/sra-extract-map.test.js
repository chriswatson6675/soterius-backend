'use strict';

// sra-extract-map.test.js — pure enumeration tests.
//
// Covers firm/office/field enumeration, anchor attachment, verbatim values,
// unknown-structure (lossless) fallback, malformed records/offices, empty/absent
// datasets, and deterministic repeatability.

const { test } = require('node:test');
const assert = require('node:assert');

const { enumerate } = require('./sra-extract-map');
const { defineSource } = require('./snapshot-source');

const SRC = defineSource({ recordsPath: ['firms'], officesPath: ['offices'], anchorPath: ['SRA number'], productionTimestampPath: ['productionDate'] });

const BODY = {
  productionDate: '2026-06-28T23:00:00Z',
  firms: [
    {
      'SRA number': '100001',
      Name: 'Acme Legal LLP',
      type: 'LLP',
      offices: [
        { officeId: '100001-0', postcode: 'LL11 1AA', website: 'https://acme.example' },
        { officeId: '100001-1', postcode: 'LL22 2BB' },
      ],
    },
    { 'SRA number': '100002', Name: 'Beta Law Ltd', offices: [] },
  ],
};

function byType(items) {
  return items.reduce((m, it) => { m[it.objectType] = (m[it.objectType] || 0) + 1; return m; }, {});
}

test('successful extraction: firm + field + office + office-field counts', () => {
  const { items } = enumerate(BODY, SRC);
  const t = byType(items);
  assert.strictEqual(t['sra.firm'], 2);
  // firm0 fields: SRA number, Name, type (offices excluded) = 3; firm1: SRA number, Name = 2 → 5
  assert.strictEqual(t['sra.firm.field'], 5);
  assert.strictEqual(t['sra.firm.office'], 2);
  // office0 fields: officeId, postcode, website = 3; office1: officeId, postcode = 2 → 5
  assert.strictEqual(t['sra.firm.office.field'], 5);
});

test('the firm record value is the firm object VERBATIM', () => {
  const { items } = enumerate(BODY, SRC);
  const firm0 = items.find((it) => it.objectType === 'sra.firm' && it.path[1] === 0);
  assert.deepStrictEqual(firm0.value, BODY.firms[0]);
  assert.strictEqual(firm0.jsonPath, 'firms[0]');
  assert.strictEqual(firm0.anchor, '100001');
});

test('nested office extraction: paths, anchor, and verbatim values', () => {
  const { items } = enumerate(BODY, SRC);
  const office0 = items.find((it) => it.objectType === 'sra.firm.office' && it.path[3] === 0);
  assert.deepStrictEqual(office0.value, BODY.firms[0].offices[0]);
  assert.strictEqual(office0.jsonPath, 'firms[0]["offices"][0]');
  assert.strictEqual(office0.anchor, '100001', 'office inherits the firm organisational anchor');

  const website = items.find((it) => it.objectType === 'sra.firm.office.field' && it.key === 'website');
  assert.strictEqual(website.value, 'https://acme.example');
  assert.strictEqual(website.jsonPath, 'firms[0]["offices"][0]["website"]');
});

test('firm fields exclude the offices container but keep everything else verbatim', () => {
  const { items } = enumerate(BODY, SRC);
  const firm0Fields = items.filter((it) => it.objectType === 'sra.firm.field' && it.path[1] === 0).map((it) => it.key);
  assert.deepStrictEqual(firm0Fields, ['SRA number', 'Name', 'type']);
  assert.ok(!firm0Fields.includes('offices'));
});

test('unknown/nested field structures are preserved VERBATIM (lossless)', () => {
  const body = { firms: [{ 'SRA number': 'X', extras: { nested: [1, 2, { a: true }] } }] };
  const { items } = enumerate(body, SRC);
  const extras = items.find((it) => it.objectType === 'sra.firm.field' && it.key === 'extras');
  assert.deepStrictEqual(extras.value, { nested: [1, 2, { a: true }] }, 'unknown structure kept whole, not dropped or flattened');
});

test('malformed records container (not an array) → lossless fallback, no throw', () => {
  const body = { firms: { unexpected: 'object' } };
  const { items, discoveries } = enumerate(body, SRC);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].objectType, 'sra.snapshot.raw');
  assert.strictEqual(items[0].unrecognised, true);
  assert.deepStrictEqual(items[0].value, { unexpected: 'object' });
  assert.strictEqual(discoveries[0].type, 'unrecognised-records-container');
});

test('malformed firm and office records → fallback items, enumeration continues', () => {
  const body = { firms: ['not-an-object', { 'SRA number': 'Y', offices: ['bad-office', { officeId: 'ok' }] }] };
  const { items, discoveries } = enumerate(body, SRC);
  assert.ok(items.some((it) => it.objectType === 'sra.firm.raw' && it.unrecognised));
  assert.ok(items.some((it) => it.objectType === 'sra.firm.office.raw' && it.unrecognised));
  // the well-formed firm + office still enumerated
  assert.ok(items.some((it) => it.objectType === 'sra.firm' && it.anchor === 'Y'));
  assert.ok(items.some((it) => it.objectType === 'sra.firm.office' && it.value.officeId === 'ok'));
  assert.ok(discoveries.some((d) => d.type === 'malformed-firm'));
  assert.ok(discoveries.some((d) => d.type === 'malformed-office'));
});

test('offices container that is not an array → fallback, no throw', () => {
  const body = { firms: [{ 'SRA number': 'Z', offices: 'oops' }] };
  const { items, discoveries } = enumerate(body, SRC);
  assert.ok(items.some((it) => it.objectType === 'sra.firm.office.raw' && it.unrecognised && it.value === 'oops'));
  assert.ok(discoveries.some((d) => d.type === 'unrecognised-offices-container'));
});

test('absent records container → observed absence (no items, no discoveries)', () => {
  assert.deepStrictEqual(enumerate({ productionDate: 'x' }, SRC), { items: [], discoveries: [] });
  assert.deepStrictEqual(enumerate({ firms: null }, SRC), { items: [], discoveries: [] });
});

test('empty firms array → zero items', () => {
  assert.deepStrictEqual(enumerate({ firms: [] }, SRC), { items: [], discoveries: [] });
});

test('anchor is null (never inferred) when the anchor key is absent', () => {
  const { items } = enumerate({ firms: [{ Name: 'No Number Ltd' }] }, SRC);
  const firm = items.find((it) => it.objectType === 'sra.firm');
  assert.strictEqual(firm.anchor, null);
});

test('deterministic: repeated enumeration of identical input is byte-identical', () => {
  const a = enumerate(BODY, SRC);
  const b = enumerate(JSON.parse(JSON.stringify(BODY)), SRC);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});
