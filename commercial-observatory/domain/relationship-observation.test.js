'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateRelationshipObservationInput,
  buildRelationshipObservationRecord,
} = require('./relationship-observation');

const BASE = {
  investigationId: 'inv-1',
  subjectOrganisation: 'Example Ltd',
  thirdPartyName: 'FCA',
  relationshipType: 'regulator',
  relationshipDirection: 'outbound',
  confidence: 'high',
  relationshipConfidenceState: 'verified',
};

describe('relationship type validation', () => {
  test('accepts every documented relationship type', () => {
    const types = [
      'regulator', 'professional_body', 'certification_body', 'trade_association',
      'client', 'client_sector', 'software_vendor', 'technology_partner',
      'referral_partner', 'strategic_partner', 'affiliated_organisation',
      'consultant', 'training_provider', 'conference_organiser', 'thought_leader',
      'supplier', 'competitor', 'unclassified',
    ];
    for (const relationshipType of types) {
      assert.strictEqual(validateRelationshipObservationInput({ ...BASE, relationshipType }).valid, true, relationshipType);
    }
  });

  test('rejects an invalid relationship type', () => {
    const { valid, errors } = validateRelationshipObservationInput({ ...BASE, relationshipType: 'sponsor' });
    assert.strictEqual(valid, false);
    assert.ok(errors.some(e => e.includes('relationshipType')));
  });
});

describe('relationship direction — never inferred from type', () => {
  test('direction is required even when the type strongly implies a direction', () => {
    const { valid, errors } = validateRelationshipObservationInput({ ...BASE, relationshipDirection: undefined });
    assert.strictEqual(valid, false);
    assert.ok(errors.some(e => e.includes('relationshipDirection')));
  });

  test('accepts each of outbound/inbound/mutual explicitly', () => {
    for (const relationshipDirection of ['outbound', 'inbound', 'mutual']) {
      assert.strictEqual(validateRelationshipObservationInput({ ...BASE, relationshipDirection }).valid, true, relationshipDirection);
    }
  });

  test('rejects an invalid direction value', () => {
    assert.strictEqual(validateRelationshipObservationInput({ ...BASE, relationshipDirection: 'sideways' }).valid, false);
  });
});

describe('buildRelationshipObservationRecord', () => {
  test('builds a full record with evidence references preserved', () => {
    const record = buildRelationshipObservationRecord({ ...BASE, evidenceReferences: ['ev-1', 'ev-2'] });
    assert.strictEqual(record.relationshipType, 'regulator');
    assert.strictEqual(record.relationshipDirection, 'outbound');
    assert.deepStrictEqual(record.evidenceReferences, ['ev-1', 'ev-2']);
  });

  test('throws on invalid input rather than silently persisting a bad record', () => {
    assert.throws(() => buildRelationshipObservationRecord({ ...BASE, relationshipType: 'bogus' }));
  });

  test('defaults evidenceReferences to an empty array, never undefined', () => {
    const record = buildRelationshipObservationRecord(BASE);
    assert.deepStrictEqual(record.evidenceReferences, []);
  });
});
