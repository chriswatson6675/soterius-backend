'use strict';

// Agent Event — one append-only audit-log entry per Research Agent step
// (execution architecture design, §D "pages visited/rejected", §F decision
// loop). This is the full audit trail an Investigation's activity is
// reconstructed from.

const { AGENT_EVENT_TYPES } = require('./constants');

function validateAgentEventInput({ investigationId, eventType, stepNumber } = {}) {
  const errors = [];
  if (!investigationId) errors.push('investigationId is required.');
  if (!AGENT_EVENT_TYPES.includes(eventType)) {
    errors.push(`eventType must be one of ${AGENT_EVENT_TYPES.join(', ')}.`);
  }
  if (!Number.isInteger(stepNumber) || stepNumber < 0) {
    errors.push('stepNumber must be a non-negative integer.');
  }
  return { valid: errors.length === 0, errors };
}

function buildAgentEventRecord({ investigationId, eventType, stepNumber, payload = {} }) {
  const { valid, errors } = validateAgentEventInput({ investigationId, eventType, stepNumber });
  if (!valid) throw new Error(`Invalid agent event: ${errors.join('; ')}`);
  return { investigationId, eventType, stepNumber, payload };
}

module.exports = { validateAgentEventInput, buildAgentEventRecord };
