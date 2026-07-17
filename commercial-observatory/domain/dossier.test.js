'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createInitialDossier,
  getIdentityFieldState,
  setIdentityField,
  validateDossierShape,
} = require('./dossier');

describe('createInitialDossier', () => {
  test('produces a validly-shaped, empty dossier', () => {
    const dossier = createInitialDossier({ name: 'Example Ltd', domain: 'example.com' });
    assert.strictEqual(validateDossierShape(dossier).valid, true);
    assert.deepStrictEqual(dossier.target, { name: 'Example Ltd', domain: 'example.com' });
    assert.strictEqual(dossier.overallConfidence, null);
    assert.strictEqual(dossier.completeness, 0);
  });
});

describe('Unknown != Absent identity field semantics', () => {
  test('a field never investigated is "unknown", not "not_found"', () => {
    const dossier = createInitialDossier({ domain: 'example.com' });
    const result = getIdentityFieldState(dossier, 'companyNumber');
    assert.strictEqual(result.state, 'unknown');
    assert.strictEqual(result.value, undefined);
  });

  test('a field investigated and confirmed absent is "not_found", distinct from unknown', () => {
    const dossier = createInitialDossier({ domain: 'example.com' });
    setIdentityField(dossier, 'companyNumber', { value: null, confidence: 'high', evidenceIds: ['ev-1'] });
    const result = getIdentityFieldState(dossier, 'companyNumber');
    assert.strictEqual(result.state, 'not_found');
    assert.strictEqual(result.value, null);
    assert.deepStrictEqual(result.evidenceIds, ['ev-1']);
  });

  test('a field with a discovered value is "known"', () => {
    const dossier = createInitialDossier({ domain: 'example.com' });
    setIdentityField(dossier, 'legalName', { value: 'Example Limited', confidence: 'medium', evidenceIds: ['ev-2'] });
    const result = getIdentityFieldState(dossier, 'legalName');
    assert.strictEqual(result.state, 'known');
    assert.strictEqual(result.value, 'Example Limited');
    assert.strictEqual(result.confidence, 'medium');
  });

  test('rejects an invalid confidence level on write', () => {
    const dossier = createInitialDossier({ domain: 'example.com' });
    assert.throws(() => setIdentityField(dossier, 'legalName', { value: 'X', confidence: 'certain' }));
  });
});

describe('validateDossierShape', () => {
  test('rejects a dossier missing required array fields', () => {
    const { valid, errors } = validateDossierShape({ target: {}, identity: {}, overallConfidence: null, completeness: 0 });
    assert.strictEqual(valid, false);
    assert.ok(errors.some(e => e.includes('observations')));
  });

  test('rejects an out-of-range completeness value', () => {
    const dossier = createInitialDossier({ domain: 'example.com' });
    dossier.completeness = 1.5;
    assert.strictEqual(validateDossierShape(dossier).valid, false);
  });

  test('rejects an invalid overallConfidence value', () => {
    const dossier = createInitialDossier({ domain: 'example.com' });
    dossier.overallConfidence = 'certain';
    assert.strictEqual(validateDossierShape(dossier).valid, false);
  });
});
