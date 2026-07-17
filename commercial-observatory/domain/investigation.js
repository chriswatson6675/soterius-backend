'use strict';

// Investigation — the durable, top-level unit of "we are trying to
// establish canonical-quality facts about organisation X" (execution
// architecture design, §B). This module defines its shape and validation
// only; persistence lives in persistence/db.js.

const { INVESTIGATION_STATUSES, canTransitionInvestigationStatus } = require('./constants');

/**
 * Validates the raw input to starting a new Investigation. At least one of
 * name/domain must be present — this is user input, so validation returns a
 * result object rather than throwing (mirrors infra/database.js's
 * {success:false, error} convention for fallible, caller-facing operations).
 */
function validateNewInvestigationInput({ name, domain } = {}) {
  const errors = [];
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedDomain = typeof domain === 'string' ? domain.trim() : '';

  if (!trimmedName && !trimmedDomain) {
    errors.push('At least one of organisation name or domain must be supplied.');
  }
  if (name !== undefined && typeof name !== 'string') {
    errors.push('name must be a string when supplied.');
  }
  if (domain !== undefined && typeof domain !== 'string') {
    errors.push('domain must be a string when supplied.');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Builds the plain-object shape for a new Investigation row (pre-insert —
 * no id, no timestamps the database itself is responsible for). `rerunOf`
 * is the prior Investigation's id when this is a resumed/rerun subject,
 * preserving that prior Investigation untouched (never overwritten).
 */
function buildNewInvestigationRecord({ name, domain, normalisedDomain, rerunOf = null }) {
  return {
    targetName: name || null,
    targetDomain: domain || null,
    targetDomainNormalised: normalisedDomain || null,
    status: 'pending',
    rerunOf,
    stepCount: 0,
    sourceCount: 0,
    startedAt: null,
    completedAt: null,
    failureReason: null,
  };
}

function isValidInvestigationStatus(status) {
  return INVESTIGATION_STATUSES.includes(status);
}

/**
 * Validates a proposed status transition against the controlled lifecycle
 * (constants.js INVESTIGATION_STATUS_TRANSITIONS). Returns {valid, errors}
 * rather than throwing, since this guards a runtime persistence operation.
 */
function validateStatusTransition(currentStatus, nextStatus) {
  const errors = [];
  if (!isValidInvestigationStatus(currentStatus)) {
    errors.push(`Unknown current status: ${currentStatus}`);
  }
  if (!isValidInvestigationStatus(nextStatus)) {
    errors.push(`Unknown target status: ${nextStatus}`);
  }
  if (errors.length === 0 && !canTransitionInvestigationStatus(currentStatus, nextStatus)) {
    errors.push(`Invalid Investigation status transition: ${currentStatus} -> ${nextStatus}`);
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateNewInvestigationInput,
  buildNewInvestigationRecord,
  isValidInvestigationStatus,
  validateStatusTransition,
};
