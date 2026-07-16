'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateObservationState,
  createObservationState,
  ObservationStateValidationError,
  VALID_STATUSES,
} = require('./observation-state');

describe('createObservationState', () => {
  test('produces a well-formed, never-yet-observed record from the minimum required fields', () => {
    const record = createObservationState({
      organisationId: 'ORG-abc123',
      observationType: 'spf',
      collectionGroup: 'dns_batch',
    });
    assert.equal(record.organisationId, 'ORG-abc123');
    assert.equal(record.observationType, 'spf');
    assert.equal(record.collectionGroup, 'dns_batch');
    assert.equal(record.status, 'never_observed');
    assert.equal(record.lastObservedAt, null);
    assert.equal(record.attemptCount, 0);
  });
});

describe('validateObservationState', () => {
  test('accepts a valid never_observed record', () => {
    assert.doesNotThrow(() => validateObservationState(createObservationState({
      organisationId: 'ORG-1', observationType: 'dkim', collectionGroup: 'dns_batch',
    })));
  });

  test('rejects a missing organisationId', () => {
    assert.throws(() => validateObservationState({
      observationType: 'spf', collectionGroup: 'dns_batch', status: 'never_observed', attemptCount: 0,
    }), ObservationStateValidationError);
  });

  test('rejects a missing observationType', () => {
    assert.throws(() => validateObservationState({
      organisationId: 'ORG-1', collectionGroup: 'dns_batch', status: 'never_observed', attemptCount: 0,
    }), ObservationStateValidationError);
  });

  test('rejects a missing collectionGroup', () => {
    assert.throws(() => validateObservationState({
      organisationId: 'ORG-1', observationType: 'spf', status: 'never_observed', attemptCount: 0,
    }), ObservationStateValidationError);
  });

  test('rejects an invalid status value', () => {
    assert.throws(() => validateObservationState({
      organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch',
      status: 'not-a-real-status', attemptCount: 0,
    }), ObservationStateValidationError);
  });

  test('every declared VALID_STATUSES value is independently accepted', () => {
    for (const status of VALID_STATUSES) {
      const record = {
        organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch',
        status, attemptCount: 0,
        lastObservedAt: status === 'observed' ? '2026-07-16T00:00:00.000Z' : null,
      };
      assert.doesNotThrow(() => validateObservationState(record), `status "${status}" should be valid`);
    }
  });

  test('rejects a negative attemptCount', () => {
    assert.throws(() => validateObservationState({
      organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch',
      status: 'never_observed', attemptCount: -1,
    }), ObservationStateValidationError);
  });

  test('rejects a non-integer attemptCount', () => {
    assert.throws(() => validateObservationState({
      organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch',
      status: 'never_observed', attemptCount: 1.5,
    }), ObservationStateValidationError);
  });

  test('rejects status "observed" with no lastObservedAt', () => {
    assert.throws(() => validateObservationState({
      organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch',
      status: 'observed', attemptCount: 1, lastObservedAt: null,
    }), ObservationStateValidationError);
  });

  test('rejects status "never_observed" with a lastObservedAt present', () => {
    assert.throws(() => validateObservationState({
      organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch',
      status: 'never_observed', attemptCount: 0, lastObservedAt: '2026-07-16T00:00:00.000Z',
    }), ObservationStateValidationError);
  });
});
