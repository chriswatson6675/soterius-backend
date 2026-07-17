'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateNewInvestigationInput,
  buildNewInvestigationRecord,
  isValidInvestigationStatus,
  validateStatusTransition,
} = require('./investigation');

describe('validateNewInvestigationInput', () => {
  test('rejects when neither name nor domain supplied', () => {
    const { valid, errors } = validateNewInvestigationInput({});
    assert.strictEqual(valid, false);
    assert.ok(errors.length > 0);
  });

  test('accepts domain only', () => {
    assert.strictEqual(validateNewInvestigationInput({ domain: 'example.com' }).valid, true);
  });

  test('accepts name only', () => {
    assert.strictEqual(validateNewInvestigationInput({ name: 'Example Ltd' }).valid, true);
  });

  test('rejects non-string name', () => {
    assert.strictEqual(validateNewInvestigationInput({ name: 123 }).valid, false);
  });
});

describe('buildNewInvestigationRecord', () => {
  test('produces the expected pending shape with zeroed counters', () => {
    const record = buildNewInvestigationRecord({ name: 'Example Ltd', domain: 'example.com', normalisedDomain: 'example.com' });
    assert.strictEqual(record.status, 'pending');
    assert.strictEqual(record.stepCount, 0);
    assert.strictEqual(record.sourceCount, 0);
    assert.strictEqual(record.rerunOf, null);
    assert.strictEqual(record.startedAt, null);
    assert.strictEqual(record.completedAt, null);
  });

  test('preserves rerunOf when supplied', () => {
    const record = buildNewInvestigationRecord({ domain: 'example.com', normalisedDomain: 'example.com', rerunOf: 'prior-id' });
    assert.strictEqual(record.rerunOf, 'prior-id');
  });
});

describe('investigation status lifecycle', () => {
  test('all six statuses are recognised', () => {
    for (const s of ['pending', 'running', 'completed', 'partial', 'failed', 'cancelled']) {
      assert.strictEqual(isValidInvestigationStatus(s), true);
    }
  });

  test('rejects an unknown status', () => {
    assert.strictEqual(isValidInvestigationStatus('bogus'), false);
  });

  test('pending -> running is a valid transition', () => {
    assert.strictEqual(validateStatusTransition('pending', 'running').valid, true);
  });

  test('completed -> running is a valid transition (a rerun of a finished investigation)', () => {
    assert.strictEqual(validateStatusTransition('completed', 'running').valid, true);
  });

  test('cancelled -> running is rejected (cancellation is genuinely terminal)', () => {
    assert.strictEqual(validateStatusTransition('cancelled', 'running').valid, false);
  });

  test('partial -> running is valid (a resumed Research Session)', () => {
    assert.strictEqual(validateStatusTransition('partial', 'running').valid, true);
  });

  test('unknown status names are rejected explicitly', () => {
    const { valid, errors } = validateStatusTransition('bogus', 'running');
    assert.strictEqual(valid, false);
    assert.ok(errors.some(e => e.includes('Unknown current status')));
  });
});
