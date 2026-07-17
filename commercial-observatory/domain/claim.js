'use strict';

// Claim — a single synthesised belief about the investigation's subject,
// pointing back to the observation(s)/evidence it rests on (execution
// architecture design, §D "beliefs"). Append-only once persisted.

const { CONFIDENCE_LEVELS, CLAIM_STATUSES } = require('./constants');

function validateClaimInput({ investigationId, claimType, field, value, confidence, status = 'active' } = {}) {
  const errors = [];
  if (!investigationId) errors.push('investigationId is required.');
  if (!claimType || typeof claimType !== 'string') errors.push('claimType must be a non-empty string.');
  if (!field || typeof field !== 'string') errors.push('field must be a non-empty string.');
  if (value === undefined) errors.push('value is required (may be null, never undefined).');
  if (!CONFIDENCE_LEVELS.includes(confidence)) {
    errors.push(`confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}.`);
  }
  if (!CLAIM_STATUSES.includes(status)) {
    errors.push(`status must be one of ${CLAIM_STATUSES.join(', ')}.`);
  }
  return { valid: errors.length === 0, errors };
}

function buildClaimRecord({ investigationId, claimType, field, value, confidence, status = 'active' }) {
  const { valid, errors } = validateClaimInput({ investigationId, claimType, field, value, confidence, status });
  if (!valid) throw new Error(`Invalid claim: ${errors.join('; ')}`);
  return { investigationId, claimType, field, value, confidence, status };
}

module.exports = { validateClaimInput, buildClaimRecord };
