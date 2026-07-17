'use strict';

// Commercial Authority Draft — the structured, reviewable output of a
// completed Investigation (execution architecture design, §B "when an
// Investigation ends"). A Draft is NOT a Canonical Partner record and this
// module creates no path into any canonical Commercial Authority or
// Organisation Authority table — review here only ever sets this
// Investigation-scoped Draft's own reviewState.

const { DRAFT_REVIEW_STATES } = require('./constants');

function validateDraftInput({ investigationId, content } = {}) {
  const errors = [];
  if (!investigationId) errors.push('investigationId is required.');
  if (!content || typeof content !== 'object') errors.push('content must be an object.');
  return { valid: errors.length === 0, errors };
}

function buildDraftRecord({ investigationId, content }) {
  const { valid, errors } = validateDraftInput({ investigationId, content });
  if (!valid) throw new Error(`Invalid draft: ${errors.join('; ')}`);
  return { investigationId, content, reviewState: 'pending', reviewedBy: null, reviewedAt: null, rejectionReason: null };
}

function validateReviewDecision({ reviewState, rejectionReason } = {}) {
  const errors = [];
  if (!DRAFT_REVIEW_STATES.includes(reviewState) || reviewState === 'pending') {
    errors.push(`reviewState must be one of: ${DRAFT_REVIEW_STATES.filter(s => s !== 'pending').join(', ')}.`);
  }
  if (reviewState === 'rejected' && (!rejectionReason || typeof rejectionReason !== 'string')) {
    errors.push('rejectionReason is required when rejecting a draft.');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { validateDraftInput, buildDraftRecord, validateReviewDecision };
