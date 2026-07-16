'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { selectCohort, UnboundedRunRefusedError } = require('./cohort-selection');

describe('selectCohort', () => {
  test('explicit organisation ids are used exactly as given', () => {
    const result = selectCohort({ explicitIds: ['ORG-2', 'ORG-1'] }, ['ORG-1', 'ORG-2', 'ORG-3']);
    assert.deepStrictEqual(result, ['ORG-2', 'ORG-1']);
  });

  test('explicit ids are deduplicated', () => {
    const result = selectCohort({ explicitIds: ['ORG-1', 'ORG-1', 'ORG-2'] }, []);
    assert.deepStrictEqual(result, ['ORG-1', 'ORG-2']);
  });

  test('a --limit with no explicit ids deterministically selects the first N, sorted', () => {
    const all = ['ORG-3', 'ORG-1', 'ORG-2', 'ORG-4'];
    const result = selectCohort({ limit: 2 }, all);
    assert.deepStrictEqual(result, ['ORG-1', 'ORG-2']);
  });

  test('the same inputs always produce the same cohort (determinism)', () => {
    const all = ['ORG-9', 'ORG-3', 'ORG-7', 'ORG-1'];
    const a = selectCohort({ limit: 3 }, all);
    const b = selectCohort({ limit: 3 }, all);
    assert.deepStrictEqual(a, b);
  });

  test('refuses to run with neither explicit ids nor a limit', () => {
    assert.throws(() => selectCohort({}, ['ORG-1', 'ORG-2']), UnboundedRunRefusedError);
  });

  test('refuses a zero or negative limit rather than treating it as unbounded', () => {
    assert.throws(() => selectCohort({ limit: 0 }, ['ORG-1']), UnboundedRunRefusedError);
    assert.throws(() => selectCohort({ limit: -5 }, ['ORG-1']), UnboundedRunRefusedError);
  });

  test('explicit ids take precedence over limit when both are given', () => {
    const result = selectCohort({ explicitIds: ['ORG-5'], limit: 100 }, ['ORG-1', 'ORG-2']);
    assert.deepStrictEqual(result, ['ORG-5']);
  });
});
