'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { PROFILES, CORE_ENDPOINTS, profile, endpointsFor } = require('./collection-profiles');
const { FIRM_ORDER } = require('./endpoint-map');

test('core profile is exactly firm + firm.address (identity + website)', () => {
  assert.deepStrictEqual(endpointsFor('core'), ['firm', 'firm.address']);
  assert.deepStrictEqual(CORE_ENDPOINTS, ['firm', 'firm.address']);
  assert.strictEqual(PROFILES.core.includesMega, false);
});

test('core profile contains NO mega and NO grandchild endpoints', () => {
  const core = endpointsFor('core');
  for (const mega of ['firm.individuals', 'firm.cf']) assert.ok(!core.includes(mega), `core must not include ${mega}`);
  for (const grandchild of ['firm.requirements.investmentTypes', 'firm.passports.permission']) {
    assert.ok(!core.includes(grandchild), `core must not include grandchild ${grandchild}`);
  }
});

test('full profile is the complete, unchanged firm family (incl. mega)', () => {
  assert.deepStrictEqual(endpointsFor('full'), [...FIRM_ORDER]);
  assert.ok(endpointsFor('full').includes('firm.individuals'));
  assert.ok(endpointsFor('full').includes('firm.cf'));
  assert.strictEqual(PROFILES.full.includesMega, true);
});

test('endpointsFor returns canonical catalogue order regardless of declared order', () => {
  // orderFor re-sorts into FIRM_ORDER, so a reversed declaration still executes correctly.
  assert.deepStrictEqual(endpointsFor('core'), ['firm', 'firm.address']); // firm precedes firm.address in FIRM_ORDER
});

test('unknown profile id fails fast (no silent default)', () => {
  assert.throws(() => profile('does-not-exist'), /unknown collection profile/);
  assert.throws(() => endpointsFor('mega'), /unknown collection profile/);
});

test('profiles are frozen (immutable configuration)', () => {
  assert.ok(Object.isFrozen(PROFILES));
  assert.ok(Object.isFrozen(PROFILES.core));
  assert.ok(Object.isFrozen(PROFILES.core.endpoints));
});
