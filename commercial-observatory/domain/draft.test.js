'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateDraftInput, buildDraftRecord, validateReviewDecision } = require('./draft');

describe('validateDraftInput / buildDraftRecord', () => {
  test('rejects a missing content object', () => {
    assert.strictEqual(validateDraftInput({ investigationId: 'inv-1' }).valid, false);
  });

  test('a new draft always starts pending, never pre-approved', () => {
    const draft = buildDraftRecord({ investigationId: 'inv-1', content: { target: { name: 'Example Ltd' } } });
    assert.strictEqual(draft.reviewState, 'pending');
    assert.strictEqual(draft.reviewedBy, null);
  });
});

describe('validateReviewDecision', () => {
  test('rejects reviewState "pending" as a decision (not a valid outcome)', () => {
    assert.strictEqual(validateReviewDecision({ reviewState: 'pending' }).valid, false);
  });

  test('approving requires no rejection reason', () => {
    assert.strictEqual(validateReviewDecision({ reviewState: 'approved' }).valid, true);
  });

  test('rejecting without a reason is invalid', () => {
    assert.strictEqual(validateReviewDecision({ reviewState: 'rejected' }).valid, false);
  });

  test('rejecting with a reason is valid', () => {
    assert.strictEqual(validateReviewDecision({ reviewState: 'rejected', rejectionReason: 'Insufficient corroboration' }).valid, true);
  });
});
