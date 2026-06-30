'use strict';

// candidate-sic.test.js — the approved SIC set is correct, deterministic, and governed.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  SIC_SET_VERSION, APPROVED_SIC, APPROVED,
  normaliseSic, isApprovedSic, matchedApproved, isCandidate,
} = require('./candidate-sic');

test('set is versioned and frozen (governed, immutable input)', () => {
  assert.strictEqual(SIC_SET_VERSION, 'fca-candidate-sic/1.0.0');
  assert.ok(Object.isFrozen(APPROVED_SIC));
  assert.strictEqual(APPROVED.size, 17, 'core INCLUDE list = 17 codes');
});

test('approved codes (Stage 1 core INCLUDE list) are members', () => {
  for (const code of ['64191', '64192', '64921', '64922', '64929', '64991', '64999',
    '65110', '65120', '65201', '65202', '66110', '66120', '66190', '66220', '66290', '66300']) {
    assert.ok(isApprovedSic(code), `${code} should be approved`);
  }
});

test('high-false-positive / excluded codes are NOT members', () => {
  for (const code of ['64205', '64110', '65300', '64301', '64910', '82910', '70229', '99999']) {
    assert.ok(!isApprovedSic(code), `${code} must be excluded`);
  }
});

test('normaliseSic parses bulk-product and API forms deterministically', () => {
  assert.strictEqual(normaliseSic('66190 - Activities auxiliary to financial intermediation n.e.c.'), '66190');
  assert.strictEqual(normaliseSic('66300'), '66300');
  assert.strictEqual(normaliseSic('Banks'), null);
  assert.strictEqual(normaliseSic(null), null);
  assert.ok(isApprovedSic('64191 - Banks'), 'bulk-product form is matched');
});

test('matchedApproved returns only approved codes (deduped); isCandidate gates on ≥1', () => {
  assert.deepStrictEqual(matchedApproved(['64205', '66190', '82990']), ['66190']);
  assert.deepStrictEqual(matchedApproved(['66220', '66220', '64205']), ['66220']);
  assert.deepStrictEqual(matchedApproved(['64205', '64110']), []);
  assert.strictEqual(isCandidate(['64205']), false, 'holding-company-only is not a candidate');
  assert.strictEqual(isCandidate(['66220', '64205']), true, 'one approved code qualifies');
  assert.strictEqual(isCandidate([]), false);
  assert.strictEqual(isCandidate(null), false);
});

test('deterministic: same input → same output', () => {
  const input = ['66190 - Activities…', '64205 - Holding', '66300'];
  assert.deepStrictEqual(matchedApproved(input), matchedApproved(input));
  assert.deepStrictEqual(matchedApproved(input), ['66190', '66300']);
});
