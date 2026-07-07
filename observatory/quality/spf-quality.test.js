'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { scoreSpfQuality, QUALITY_VERSION } = require('./spf-quality');

const present = (mech, extra = {}) => ({ spf_present: true, spf_mechanism: mech, spf_syntax_errors: [], spf_lookup_count: 2, ...extra });
const errs = (...codes) => codes.map(code => ({ code }));

describe('SPF Quality — primary scores', () => {
  test('-all → 100', () => assert.equal(scoreSpfQuality(present('-all')).score, 100));
  test('~all → 90',  () => assert.equal(scoreSpfQuality(present('~all')).score, 90));
  test('?all → 60',  () => assert.equal(scoreSpfQuality(present('?all')).score, 60));
  test('+all → 5',   () => assert.equal(scoreSpfQuality(present('+all')).score, 5));
  test('absent → 0', () => assert.equal(scoreSpfQuality({ spf_present: false, spf_mechanism: null, spf_syntax_errors: [] }).score, 0));

  test('unknown → not scored', () => {
    const r = scoreSpfQuality({ spf_present: null });
    assert.equal(r.scored, false);
    assert.equal(r.score, null);
    assert.equal(r.reason, 'OBSERVATION_INCOMPLETE');
  });
});

describe('SPF Quality — Missing all is primary-only (no double penalty)', () => {
  test('present, no all, MISSING_ALL_MECHANISM flagged → 40 (NOT 34)', () => {
    const r = scoreSpfQuality(present(null, { spf_syntax_errors: errs('MISSING_ALL_MECHANISM') }));
    assert.equal(r.score, 40);
    assert.equal(r.primary, 40);
    assert.equal(r.primaryLabel, 'Missing all');
    assert.deepEqual(r.applied, []); // no multiplier fires for missing all
  });

  test('present, no all, redirect (unflagged) → 40', () => {
    const r = scoreSpfQuality(present(null));
    assert.equal(r.score, 40);
    assert.equal(r.primaryLabel, 'Missing all');
  });
});

describe('SPF Quality — fatal (×0) multipliers', () => {
  const fatalCases = [
    ['multiple records', present('-all', { spf_multiple_records: true, spf_record_count: 2, spf_syntax_errors: errs('MULTIPLE_SPF_RECORDS') })],
    ['invalid version',  present('-all', { spf_syntax_errors: errs('INVALID_VERSION') })],
    ['unknown mechanism',present('-all', { spf_syntax_errors: errs('UNKNOWN_MECHANISM') })],
    ['malformed include',present('-all', { spf_syntax_errors: errs('MALFORMED_INCLUDE') })],
    ['malformed IP',     present('-all', { spf_syntax_errors: errs('MALFORMED_IP4') })],
    ['invalid IP',       present('-all', { spf_syntax_errors: errs('INVALID_IP4') })],
  ];
  for (const [label, facts] of fatalCases) {
    test(`${label} → 0 and fatal=true`, () => {
      const r = scoreSpfQuality(facts);
      assert.equal(r.score, 0);
      assert.equal(r.fatal, true);
    });
  }
});

describe('SPF Quality — soft multipliers', () => {
  test('duplicate all → ×0.95 (100→95)', () => assert.equal(scoreSpfQuality(present('-all', { spf_syntax_errors: errs('DUPLICATE_ALL') })).score, 95));
  test('all not last → ×0.90 (100→90)',  () => assert.equal(scoreSpfQuality(present('-all', { spf_syntax_errors: errs('ALL_NOT_LAST') })).score, 90));
  test('near lookup limit (≥8) → ×0.95 (100→95)', () => assert.equal(scoreSpfQuality(present('-all', { spf_lookup_count: 9 })).score, 95));
  test('lookup 7 is not near-limit', () => assert.equal(scoreSpfQuality(present('-all', { spf_lookup_count: 7 })).score, 100));
  test('~all + near-limit → 85.5', () => assert.equal(scoreSpfQuality(present('~all', { spf_lookup_count: 10 })).score, 85.5));
  test('multiplicative stack: -all + dup + near → 100×0.95×0.95 = 90.25', () =>
    assert.equal(scoreSpfQuality(present('-all', { spf_lookup_count: 8, spf_syntax_errors: errs('DUPLICATE_ALL') })).score, 90.25));
});

describe('SPF Quality — fatal dominates soft', () => {
  test('unknown mechanism + duplicate all → 0', () =>
    assert.equal(scoreSpfQuality(present('-all', { spf_syntax_errors: errs('UNKNOWN_MECHANISM', 'DUPLICATE_ALL') })).score, 0));
});

describe('SPF Quality — versioning', () => {
  test('QUALITY_VERSION is 1.0', () => assert.equal(QUALITY_VERSION, '1.0'));
});
