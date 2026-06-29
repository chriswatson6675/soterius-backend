'use strict';

// endpoint-map.test.js — Phase 3 catalogue tests (IMP-FCA-001 §3).

const { test } = require('node:test');
const assert = require('node:assert');
const map = require('./endpoint-map');

test('orderFor(firm): parent first, grandchildren after their dependency parent', () => {
  const order = map.orderFor('firm');
  assert.strictEqual(order[0], 'firm', 'parent first');
  assert.ok(order.indexOf('firm.requirements') < order.indexOf('firm.requirements.investmentTypes'));
  assert.ok(order.indexOf('firm.passports') < order.indexOf('firm.passports.permission'));
  // every child comes after the parent
  for (const id of order) {
    const d = map.def(id);
    if (d.parent) assert.ok(order.indexOf(d.parent) < order.indexOf(id), `${d.parent} before ${id}`);
  }
});

test('orderFor with a subset preserves canonical order and drops the rest', () => {
  const order = map.orderFor('firm', ['firm.address', 'firm', 'firm.regulators']);
  assert.deepStrictEqual(order, ['firm', 'firm.address', 'firm.regulators']);
});

test('pathFor builds correct firm and grandchild URLs', () => {
  assert.strictEqual(map.pathFor('firm', '122702'), '/Firm/122702');
  assert.strictEqual(map.pathFor('firm.permissions', '122702'), '/Firm/122702/Permissions');
  assert.strictEqual(map.pathFor('firm.requirements.investmentTypes', '122702', 'OR-1'), '/Firm/122702/Requirements/OR-1/InvestmentTypes');
  assert.strictEqual(map.pathFor('firm.passports.permission', '122702', 'GIBRALTAR'), '/Firm/122702/Passports/GIBRALTAR/Permission');
});

test('dependencyIds: requirement references extracted from documented keys', () => {
  const parentBody = { Data: [{ 'Requirement Reference': 'OR-1' }, { 'Requirement Reference': 'OR-2' }, { 'Effective Date': 'x' }] };
  assert.deepStrictEqual(map.dependencyIds('firm.requirements.investmentTypes', parentBody), ['OR-1', 'OR-2']);
});

test('dependencyIds: passport countries extracted from nested Passports', () => {
  const parentBody = { Data: [{ Passports: [{ Country: 'GIBRALTAR' }, { Country: 'IRELAND' }] }] };
  assert.deepStrictEqual(map.dependencyIds('firm.passports.permission', parentBody), ['GIBRALTAR', 'IRELAND']);
});

test('dependencyIds: empty when parent has none', () => {
  assert.deepStrictEqual(map.dependencyIds('firm.passports.permission', { Data: [{}] }), []);
  assert.deepStrictEqual(map.dependencyIds('firm.requirements.investmentTypes', { Data: null }), []);
});

test('families are declared (firm, individual, product)', () => {
  assert.ok(map.orderFor('firm').length >= 14);
  assert.deepStrictEqual(map.orderFor('individual'), ['individual', 'individual.cf', 'individual.disciplinaryHistory']);
  assert.deepStrictEqual(map.orderFor('product'), ['cis', 'cis.names', 'cis.subfund']);
});

test('unknown family / endpoint raise clear errors', () => {
  assert.throws(() => map.orderFor('nope'), /unknown family/);
  assert.throws(() => map.pathFor('nope', 'x'), /unknown endpoint/);
});
