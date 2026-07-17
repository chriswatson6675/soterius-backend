'use strict';

// Organisation Dossier — the Research Agent's mutable working memory
// (execution architecture design, §D). This module defines its shape,
// the Unknown != Absent field-state discipline, and mutation helpers.
// Persistence (versioned JSONB storage) lives in persistence/db.js.
//
// The dossier deliberately holds only REFERENCES into the evidence ledger
// (evidence ids), never raw page bodies or full source material — those
// live in commercial_evidence, addressed by id.

const { CONFIDENCE_LEVELS } = require('./constants');

/**
 * Builds the initial (empty) dossier for a freshly created Investigation.
 * Every collection starts empty; `identity` starts as an empty object so
 * that every field on it is in the "unknown" state (see getIdentityFieldState)
 * until the agent explicitly investigates it.
 */
function createInitialDossier({ name, domain } = {}) {
  return {
    target: { name: name || null, domain: domain || null },
    identity: {},
    observations: [],
    beliefs: [],
    relationshipObservations: [],
    evidenceReferences: [],
    unansweredQuestions: [],
    contradictions: [],
    hypotheses: [],
    discoveredOrganisations: [],
    discoveredPeople: [],
    pagesVisited: [],
    pagesRejected: [],
    nextActions: [],
    // Ids of commercial_relationship_observations rows that deterministic
    // review has since found unsupported (e.g. the HMRC false-positive
    // precision-pass correction) — the original append-only row is never
    // touched; this list is how the dossier's own relationshipObservations
    // summary stays honest without mutating or deleting history.
    rejectedRelationshipObservationIds: [],
    completionNotes: null,
    overallConfidence: null, // null = not yet assessed (Unknown, not Absent)
    completeness: 0,
  };
}

/**
 * Unknown != Absent, made concrete for a single identity field:
 *   - key absent from dossier.identity           -> 'unknown'    (not yet investigated)
 *   - key present, value === null                -> 'not_found'  (investigated, confirmed absent)
 *   - key present, value !== null                 -> 'known'      (investigated, a value was found)
 *
 * Returns { state, value, confidence, evidenceIds } — value/confidence/
 * evidenceIds are only meaningful when state !== 'unknown'.
 */
function getIdentityFieldState(dossier, fieldName) {
  if (!dossier || !dossier.identity || !Object.prototype.hasOwnProperty.call(dossier.identity, fieldName)) {
    return { state: 'unknown', value: undefined, confidence: undefined, evidenceIds: undefined };
  }
  const field = dossier.identity[fieldName];
  if (field === null || field.value === null) {
    return { state: 'not_found', value: null, confidence: field?.confidence ?? null, evidenceIds: field?.evidenceIds ?? [] };
  }
  return {
    state: 'known',
    value: field.value,
    confidence: field.confidence ?? null,
    evidenceIds: field.evidenceIds ?? [],
  };
}

/**
 * Sets an identity field to a "checked" state — either a found value or an
 * explicit not-found (value: null). Never call this to represent "not yet
 * investigated"; simply never set the key at all for that state.
 */
function setIdentityField(dossier, fieldName, { value, confidence = null, evidenceIds = [] } = {}) {
  if (confidence !== null && !CONFIDENCE_LEVELS.includes(confidence)) {
    throw new Error(`Invalid confidence level: ${confidence}`);
  }
  dossier.identity[fieldName] = { value, confidence, evidenceIds };
  return dossier;
}

/**
 * Validates the overall dossier shape — used defensively before persisting
 * or after reading back a JSONB blob, to catch drift early rather than
 * silently operating on a malformed working-memory object.
 */
function validateDossierShape(dossier) {
  const errors = [];
  if (!dossier || typeof dossier !== 'object') {
    return { valid: false, errors: ['Dossier must be an object.'] };
  }

  const arrayFields = [
    'observations', 'beliefs', 'relationshipObservations', 'evidenceReferences',
    'unansweredQuestions', 'contradictions', 'hypotheses', 'discoveredOrganisations',
    'discoveredPeople', 'pagesVisited', 'pagesRejected', 'nextActions',
    'rejectedRelationshipObservationIds',
  ];
  for (const field of arrayFields) {
    if (!Array.isArray(dossier[field])) errors.push(`dossier.${field} must be an array.`);
  }
  if (!dossier.target || typeof dossier.target !== 'object') {
    errors.push('dossier.target must be an object.');
  }
  if (!dossier.identity || typeof dossier.identity !== 'object') {
    errors.push('dossier.identity must be an object.');
  }
  if (dossier.overallConfidence !== null && !CONFIDENCE_LEVELS.includes(dossier.overallConfidence)) {
    errors.push(`dossier.overallConfidence must be null or one of ${CONFIDENCE_LEVELS.join(', ')}.`);
  }
  if (typeof dossier.completeness !== 'number' || dossier.completeness < 0 || dossier.completeness > 1) {
    errors.push('dossier.completeness must be a number between 0 and 1.');
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  createInitialDossier,
  getIdentityFieldState,
  setIdentityField,
  validateDossierShape,
};
