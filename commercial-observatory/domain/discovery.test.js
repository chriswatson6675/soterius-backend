'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateDiscoveryInput, buildDiscoveryRecord } = require('./discovery');

describe('validateDiscoveryInput', () => {
  test('requires a discovery reason (never emitted without justification)', () => {
    const result = validateDiscoveryInput({ investigationId: 'inv-1', discoveredName: 'GRC Consultants Ltd', discoveryReason: '' });
    assert.strictEqual(result.valid, false);
  });

  test('accepts a well-formed discovery', () => {
    const result = validateDiscoveryInput({
      investigationId: 'inv-1', discoveredName: 'GRC Consultants Ltd', discoveryReason: 'Named as certifying body on target\'s website',
    });
    assert.strictEqual(result.valid, true);
  });
});

describe('buildDiscoveryRecord', () => {
  test('normalises discovered domain and name', () => {
    const record = buildDiscoveryRecord({
      investigationId: 'inv-1',
      discoveredName: 'GRC Consultants Limited',
      discoveredDomain: 'https://WWW.grcconsultants.co.uk/',
      discoveryReason: 'Named as a certification body',
    });
    assert.strictEqual(record.discoveredDomainNormalised, 'grcconsultants.co.uk');
    assert.strictEqual(record.discoveredNameNormalised, 'GRC CONSULTANTS');
  });

  test('defaults eligibleForFutureInvestigation to true', () => {
    const record = buildDiscoveryRecord({ investigationId: 'inv-1', discoveredName: 'X', discoveryReason: 'mentioned' });
    assert.strictEqual(record.eligibleForFutureInvestigation, true);
  });

  test('throws on an invalid proposedRelationshipType', () => {
    assert.throws(() => buildDiscoveryRecord({
      investigationId: 'inv-1', discoveredName: 'X', discoveryReason: 'mentioned', proposedRelationshipType: 'sponsor',
    }));
  });
});
