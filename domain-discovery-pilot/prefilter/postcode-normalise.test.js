'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalisePostcode } = require('./postcode-normalise');

test('normalisePostcode: reinserts a single space before the inward code', () => {
  assert.equal(normalisePostcode('sw1a1aa'), 'SW1A 1AA');
  assert.equal(normalisePostcode('SW1A   1AA'), 'SW1A 1AA');
  assert.equal(normalisePostcode('eh11bb'), 'EH1 1BB');
});

test('normalisePostcode: already-correct postcode is idempotent', () => {
  assert.equal(normalisePostcode('SW1A 1AA'), 'SW1A 1AA');
});

test('normalisePostcode: returns null for implausible input', () => {
  assert.equal(normalisePostcode(''), null);
  assert.equal(normalisePostcode(null), null);
  assert.equal(normalisePostcode(undefined), null);
  assert.equal(normalisePostcode('NOTAPOSTCODE'), null);
  assert.equal(normalisePostcode('123'), null);
});

test('normalisePostcode: single-letter outward area', () => {
  assert.equal(normalisePostcode('m11ae'), 'M1 1AE');
});
