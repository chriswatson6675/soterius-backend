'use strict';

// Observation State — OBS-101 (Observation Foundation), WP-1 of the
// Observation Platform implementation programme.
//
// Pure domain contract for the one deliberately mutable object in the frozen
// Observation Domain Architecture (Organisation → Observation Definition →
// Observation State → Evidence → Trust Profile). No DB access in this module
// — see store.js for persistence. No scheduling/due-selection logic — that is
// WP-4/WP-5, not this work package.
//
// "Observation State" is distinct from OBS-CONST-001's own constitutional
// object named "Observation" (the immutable persisted fact — this
// programme's Evidence). This module never touches that object.

const VALID_STATUSES = ['never_observed', 'due', 'running', 'observed', 'failed', 'suspended'];

class ObservationStateValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ObservationStateValidationError';
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * validateObservationState(record) — throws ObservationStateValidationError
 * on any structural defect; returns nothing on success.
 *
 * Deliberately narrow: checks shape and internal consistency only. It has no
 * opinion on cadence, scheduling, or collection — those are other work
 * packages' concerns.
 */
function validateObservationState(record) {
  if (record == null || typeof record !== 'object') {
    throw new ObservationStateValidationError('record must be an object');
  }
  if (!isNonEmptyString(record.organisationId)) {
    throw new ObservationStateValidationError('organisationId must be a non-empty string');
  }
  if (!isNonEmptyString(record.observationType)) {
    throw new ObservationStateValidationError('observationType must be a non-empty string');
  }
  if (!isNonEmptyString(record.collectionGroup)) {
    throw new ObservationStateValidationError('collectionGroup must be a non-empty string');
  }
  if (!VALID_STATUSES.includes(record.status)) {
    throw new ObservationStateValidationError(`status must be one of ${VALID_STATUSES.join(', ')}`);
  }
  if (!Number.isInteger(record.attemptCount) || record.attemptCount < 0) {
    throw new ObservationStateValidationError('attemptCount must be a non-negative integer');
  }
  // S-consistency: 'observed' implies a last_observed_at is actually known.
  if (record.status === 'observed' && !isNonEmptyString(record.lastObservedAt)) {
    throw new ObservationStateValidationError('status "observed" requires a non-empty lastObservedAt');
  }
  // 'never_observed' is, by definition, never accompanied by a last-observed reading.
  if (record.status === 'never_observed' && record.lastObservedAt != null) {
    throw new ObservationStateValidationError('status "never_observed" must not have a lastObservedAt');
  }
}

/**
 * createObservationState({ organisationId, observationType, collectionGroup }) →
 * a well-formed, never-yet-observed Observation State — the only construction
 * path this module exposes. Every other field defaults to the honest
 * "nothing has happened yet" state; nothing here schedules or observes
 * anything.
 */
function createObservationState({ organisationId, observationType, collectionGroup }) {
  const record = {
    organisationId,
    observationType,
    collectionGroup,
    lastObservedAt: null,
    nextDueAt: null,
    status: 'never_observed',
    collectorVersion: null,
    evidenceRef: null,
    provenanceRef: null,
    materialChange: null,
    attemptCount: 0,
    lastFailureAt: null,
    lastFailureReason: null,
  };
  validateObservationState(record);
  return record;
}

module.exports = {
  VALID_STATUSES,
  ObservationStateValidationError,
  validateObservationState,
  createObservationState,
};
