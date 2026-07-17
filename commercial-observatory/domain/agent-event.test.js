'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateAgentEventInput, buildAgentEventRecord } = require('./agent-event');

describe('validateAgentEventInput', () => {
  test('accepts a known event type with a valid step number', () => {
    assert.strictEqual(validateAgentEventInput({ investigationId: 'inv-1', eventType: 'investigation_created', stepNumber: 0 }).valid, true);
  });

  test('rejects an unknown event type', () => {
    assert.strictEqual(validateAgentEventInput({ investigationId: 'inv-1', eventType: 'made_up', stepNumber: 0 }).valid, false);
  });

  test('rejects a negative step number', () => {
    assert.strictEqual(validateAgentEventInput({ investigationId: 'inv-1', eventType: 'investigation_created', stepNumber: -1 }).valid, false);
  });
});

describe('buildAgentEventRecord', () => {
  test('defaults payload to an empty object', () => {
    const event = buildAgentEventRecord({ investigationId: 'inv-1', eventType: 'investigation_created', stepNumber: 0 });
    assert.deepStrictEqual(event.payload, {});
  });

  test('throws on invalid input', () => {
    assert.throws(() => buildAgentEventRecord({ investigationId: 'inv-1', eventType: 'bogus', stepNumber: 0 }));
  });
});
