'use strict';

// Relationship Observation — a single classified, directional, evidenced
// observation of a third-party entity's relationship to the investigation's
// subject (Relationship Discovery model). Direction is always explicit and
// is never inferred merely from relationship type, per the founder's
// instruction — validation enforces that both are supplied independently.

const {
  RELATIONSHIP_TYPES,
  RELATIONSHIP_DIRECTIONS,
  RELATIONSHIP_CONFIDENCE_STATES,
  CONFIDENCE_LEVELS,
} = require('./constants');

function validateRelationshipObservationInput({
  investigationId,
  subjectOrganisation,
  thirdPartyName,
  relationshipType,
  relationshipDirection,
  confidence,
  relationshipConfidenceState,
  evidenceReferences,
} = {}) {
  const errors = [];
  if (!investigationId) errors.push('investigationId is required.');
  if (!subjectOrganisation || typeof subjectOrganisation !== 'string') {
    errors.push('subjectOrganisation must be a non-empty string.');
  }
  if (!thirdPartyName || typeof thirdPartyName !== 'string') {
    errors.push('thirdPartyEntityName must be a non-empty string.');
  }
  if (!RELATIONSHIP_TYPES.includes(relationshipType)) {
    errors.push(`relationshipType must be one of ${RELATIONSHIP_TYPES.join(', ')}.`);
  }
  if (!RELATIONSHIP_DIRECTIONS.includes(relationshipDirection)) {
    errors.push(`relationshipDirection must be one of ${RELATIONSHIP_DIRECTIONS.join(', ')} — direction must be supplied explicitly and is never inferred from relationshipType.`);
  }
  if (!CONFIDENCE_LEVELS.includes(confidence)) {
    errors.push(`confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}.`);
  }
  if (!RELATIONSHIP_CONFIDENCE_STATES.includes(relationshipConfidenceState)) {
    errors.push(`relationshipConfidenceState must be one of ${RELATIONSHIP_CONFIDENCE_STATES.join(', ')}.`);
  }
  if (evidenceReferences !== undefined && !Array.isArray(evidenceReferences)) {
    errors.push('evidenceReferences must be an array when supplied.');
  }
  return { valid: errors.length === 0, errors };
}

function buildRelationshipObservationRecord(input) {
  const { valid, errors } = validateRelationshipObservationInput(input);
  if (!valid) throw new Error(`Invalid relationship observation: ${errors.join('; ')}`);
  const {
    investigationId,
    subjectOrganisation,
    thirdPartyName,
    thirdPartyDomain = null,
    thirdPartyDomainNormalised = null,
    relationshipType,
    relationshipDirection,
    confidence,
    relationshipConfidenceState,
    contextExcerpt = null,
    evidenceReferences = [],
  } = input;
  return {
    investigationId,
    subjectOrganisation,
    thirdPartyName,
    thirdPartyDomain,
    thirdPartyDomainNormalised,
    relationshipType,
    relationshipDirection,
    confidence,
    relationshipConfidenceState,
    contextExcerpt,
    evidenceReferences,
  };
}

module.exports = {
  RELATIONSHIP_TYPES,
  RELATIONSHIP_DIRECTIONS,
  RELATIONSHIP_CONFIDENCE_STATES,
  validateRelationshipObservationInput,
  buildRelationshipObservationRecord,
};
