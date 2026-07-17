'use strict';

// Discovery — a candidate future investigation surfaced in passing while
// researching a different subject (execution architecture design, §I). A
// Discovery is emitted, held, and never auto-promoted into a Canonical
// Partner record or a new Investigation — promotion is always a separate,
// deliberate act performed later, outside this module.

const { RELATIONSHIP_TYPES } = require('./constants');
const { normaliseDomain, normaliseName } = require('../../authority/lib/normalise');

function validateDiscoveryInput({ investigationId, discoveredName, discoveryReason, eligibleForFutureInvestigation } = {}) {
  const errors = [];
  if (!investigationId) errors.push('investigationId is required.');
  if (!discoveredName || typeof discoveredName !== 'string') {
    errors.push('discoveredName must be a non-empty string.');
  }
  if (!discoveryReason || typeof discoveryReason !== 'string') {
    errors.push('discoveryReason must be a non-empty string (why this entity was surfaced).');
  }
  if (eligibleForFutureInvestigation !== undefined && typeof eligibleForFutureInvestigation !== 'boolean') {
    errors.push('eligibleForFutureInvestigation must be a boolean when supplied.');
  }
  return { valid: errors.length === 0, errors };
}

function buildDiscoveryRecord({
  investigationId,
  discoveredName,
  discoveredDomain = null,
  discoveryReason,
  proposedRelationshipType = 'unclassified',
  eligibleForFutureInvestigation = true,
}) {
  const { valid, errors } = validateDiscoveryInput({ investigationId, discoveredName, discoveryReason, eligibleForFutureInvestigation });
  if (!valid) throw new Error(`Invalid discovery: ${errors.join('; ')}`);
  if (!RELATIONSHIP_TYPES.includes(proposedRelationshipType)) {
    throw new Error(`Invalid proposedRelationshipType: ${proposedRelationshipType}`);
  }
  return {
    investigationId,
    discoveredName,
    discoveredDomain,
    discoveredDomainNormalised: normaliseDomain(discoveredDomain),
    discoveredNameNormalised: normaliseName(discoveredName),
    discoveryReason,
    proposedRelationshipType,
    eligibleForFutureInvestigation,
  };
}

module.exports = { validateDiscoveryInput, buildDiscoveryRecord };
