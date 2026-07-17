'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateClaimInput, buildClaimRecord } = require('./claim');

describe('validateClaimInput', () => {
  test('accepts a well-formed claim', () => {
    const result = validateClaimInput({
      investigationId: 'inv-1', claimType: 'identity', field: 'legalName', value: 'Example Ltd', confidence: 'high',
    });
    assert.strictEqual(result.valid, true);
  });

  test('rejects an invalid confidence level', () => {
    const result = validateClaimInput({
      investigationId: 'inv-1', claimType: 'identity', field: 'legalName', value: 'Example Ltd', confidence: 'certain',
    });
    assert.strictEqual(result.valid, false);
  });

  test('a null value is valid (an honest not-found), undefined is not', () => {
    assert.strictEqual(validateClaimInput({
      investigationId: 'inv-1', claimType: 'identity', field: 'companyNumber', value: null, confidence: 'high',
    }).valid, true);
    assert.strictEqual(validateClaimInput({
      investigationId: 'inv-1', claimType: 'identity', field: 'companyNumber', value: undefined, confidence: 'high',
    }).valid, false);
  });

  test('rejects an invalid status', () => {
    const result = validateClaimInput({
      investigationId: 'inv-1', claimType: 'identity', field: 'legalName', value: 'X', confidence: 'high', status: 'made-up',
    });
    assert.strictEqual(result.valid, false);
  });
});

describe('buildClaimRecord', () => {
  test('throws on invalid input', () => {
    assert.throws(() => buildClaimRecord({ investigationId: 'inv-1', claimType: 'identity', field: 'x', value: 'y', confidence: 'nope' }));
  });

  test('defaults status to active', () => {
    const claim = buildClaimRecord({ investigationId: 'inv-1', claimType: 'identity', field: 'legalName', value: 'Example Ltd', confidence: 'medium' });
    assert.strictEqual(claim.status, 'active');
  });
});
