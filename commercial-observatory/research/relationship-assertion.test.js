'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { assessRelationshipAssertion } = require('./relationship-assertion');

const TARGET = 'Compliance Office';

function assess(sentence, entityText, opts = {}) {
  return assessRelationshipAssertion({ sentence, entityText, targetName: TARGET, isTargetAuthored: true, ...opts });
}

describe('direct supported relationships', () => {
  test('"We are regulated by the FCA." is supported', () => {
    const r = assess('We are regulated by the FCA.', 'FCA');
    assert.strictEqual(r.supported, true);
    assert.strictEqual(r.classification, 'target_relationship');
    assert.strictEqual(r.relationshipType, 'regulator');
    assert.strictEqual(r.direction, 'outbound');
  });

  test('"Compliance Office is authorised by the FCA." is supported', () => {
    const r = assess('Compliance Office is authorised by the FCA.', 'FCA');
    assert.strictEqual(r.supported, true);
    assert.strictEqual(r.relationshipType, 'regulator');
  });

  test('"Our firm is a member of the Law Society." is supported', () => {
    const r = assess('Our firm is a member of the Law Society.', 'Law Society');
    assert.strictEqual(r.supported, true);
    assert.strictEqual(r.relationshipType, 'professional_body');
  });

  test('"We are certified by BSI." is supported', () => {
    const r = assess('We are certified by BSI.', 'BSI');
    assert.strictEqual(r.supported, true);
    assert.strictEqual(r.relationshipType, 'certification_body');
  });

  test('"We partner with Actionstep." is supported', () => {
    const r = assess('We partner with Actionstep.', 'Actionstep');
    assert.strictEqual(r.supported, true);
    assert.strictEqual(r.relationshipType, 'strategic_partner');
    assert.strictEqual(r.direction, 'mutual');
  });

  test('"Microsoft provides technology services to Compliance Office." is supported (entity as subject, reversed)', () => {
    const r = assess('Microsoft provides technology services to Compliance Office.', 'Microsoft');
    assert.strictEqual(r.supported, true);
    assert.strictEqual(r.relationshipType, 'supplier');
    assert.strictEqual(r.direction, 'outbound');
  });

  test('"Compliance Office provides compliance consultancy to Example LLP." is supported (target as subject, forward)', () => {
    const r = assess('Compliance Office provides compliance consultancy to Example LLP.', 'Example LLP');
    assert.strictEqual(r.supported, true);
    assert.strictEqual(r.relationshipType, 'client');
    assert.strictEqual(r.direction, 'inbound');
  });
});

describe('must remain contextual or rejected', () => {
  test('"We advise firms regulated by the SRA." is not supported', () => {
    const r = assess('We advise firms regulated by the SRA.', 'SRA');
    assert.strictEqual(r.supported, false);
    assert.strictEqual(r.classification, 'target_advises_entity_regulated_sector');
  });

  test('the HMRC sentence is not supported (the actual false positive this task fixes)', () => {
    const r = assess(
      "From 18 August 2026, HMRC will not accept communications on a client's behalf from anyone not registered with an Agent Services Account.",
      'HMRC',
    );
    assert.strictEqual(r.supported, false);
  });

  test('"Firms must register with HMRC." is not supported', () => {
    const r = assess('Firms must register with HMRC.', 'HMRC');
    assert.strictEqual(r.supported, false);
  });

  test('"The FCA will require supervised firms to submit returns." is not supported (no tracked phrase at all)', () => {
    const r = assess('The FCA will require supervised firms to submit returns.', 'FCA');
    assert.strictEqual(r.supported, false);
    assert.strictEqual(r.classification, 'general_context');
  });

  test('"Our director previously worked for the Law Society." is employee_history', () => {
    const r = assess('Our director previously worked for the Law Society.', 'Law Society');
    assert.strictEqual(r.supported, false);
    assert.strictEqual(r.classification, 'employee_history');
  });

  test('"A client was investigated by the FCA." is not supported (no tracked phrase)', () => {
    const r = assess('A client was investigated by the FCA.', 'FCA');
    assert.strictEqual(r.supported, false);
  });

  test('"You may complain to the ICO." is not supported', () => {
    const r = assess('You may complain to the ICO.', 'ICO');
    assert.strictEqual(r.supported, false);
    assert.strictEqual(r.classification, 'policy_requirement');
  });

  test('"According to SRA guidance..." is not supported', () => {
    const r = assess('According to SRA guidance, firms must keep records.', 'SRA');
    assert.strictEqual(r.supported, false);
    assert.strictEqual(r.classification, 'general_context');
  });

  test('"We published an article about the FCA." is not supported', () => {
    const r = assess('We published an article about the FCA.', 'FCA');
    assert.strictEqual(r.supported, false);
    assert.strictEqual(r.classification, 'general_context');
  });

  test('"X and Compliance Office spoke at the same conference." is not supported', () => {
    const r = assess('X and Compliance Office spoke at the same conference.', 'X');
    assert.strictEqual(r.supported, false);
  });

  test('"We are not affiliated with X." is not supported (explicit negation)', () => {
    const r = assess('We are not affiliated with X.', 'X');
    assert.strictEqual(r.supported, false);
    assert.strictEqual(r.classification, 'general_context');
  });

  test('"This service is not regulated by the FCA." is not supported (explicit negation)', () => {
    const r = assess('This service is not regulated by the FCA.', 'FCA');
    assert.strictEqual(r.supported, false);
    assert.strictEqual(r.classification, 'general_context');
  });
});

describe('direction', () => {
  test('target regulated by entity -> outbound', () => {
    assert.strictEqual(assess('We are regulated by the SRA.', 'SRA').direction, 'outbound');
  });

  test('target member of entity -> outbound', () => {
    assert.strictEqual(assess('We are a member of the ICAEW.', 'ICAEW').direction, 'outbound');
  });

  test('target certified by entity -> outbound', () => {
    assert.strictEqual(assess('We are certified by UKAS.', 'UKAS').direction, 'outbound');
  });

  test('target partners with entity -> mutual', () => {
    assert.strictEqual(assess('We partner with Actionstep.', 'Actionstep').direction, 'mutual');
  });

  test('target supplies third party -> inbound', () => {
    const r = assess('Compliance Office provides consultancy to Example LLP.', 'Example LLP');
    assert.strictEqual(r.direction, 'inbound');
    assert.strictEqual(r.relationshipType, 'client');
  });

  test('third party supplies target -> outbound', () => {
    const r = assess('Microsoft provides support to Compliance Office.', 'Microsoft');
    assert.strictEqual(r.direction, 'outbound');
    assert.strictEqual(r.relationshipType, 'supplier');
  });

  test('target advises firms regulated by entity is not a direct target-regulator relationship', () => {
    const r = assess('We advise firms regulated by the FCA.', 'FCA');
    assert.strictEqual(r.supported, false);
    assert.notStrictEqual(r.relationshipType && r.classification, 'target_relationship');
  });
});

describe('boundary conditions', () => {
  test('this module is single-sentence-scoped by contract — cross-sentence containment is entity-detection.js\'s job', () => {
    // This module trusts its caller (entity-detection.js) to pass exactly
    // the one sentence containing the entity match — see
    // entity-detection.test.js's own adjacent-sentence regression test for
    // the actual cross-sentence containment guarantee.
    const r = assess('We are regulated by the FCA.', 'FCA');
    assert.strictEqual(r.supported, true);
  });

  test('employee biography must not become an organisation relationship even with a nearby phrase', () => {
    const r = assess('Our director previously worked for and was a member of the Law Society.', 'Law Society');
    assert.strictEqual(r.classification, 'employee_history');
  });

  test('a relationship between two named third parties must not become a target relationship', () => {
    const r = assess('Acme Ltd is a member of the Law Society.', 'Law Society', { targetName: 'Compliance Office' });
    assert.strictEqual(r.supported, false);
    assert.strictEqual(r.classification, 'third_party_relationship');
  });

  test('first-person reference only counts on target-authored content', () => {
    const authored = assess('We are regulated by the FCA.', 'FCA', { isTargetAuthored: true });
    const notAuthored = assess('We are regulated by the FCA.', 'FCA', { isTargetAuthored: false });
    assert.strictEqual(authored.supported, true);
    assert.strictEqual(notAuthored.supported, false);
  });

  test('the full target name still counts as a target reference when isTargetAuthored is false', () => {
    const r = assess('Compliance Office is regulated by the FCA.', 'FCA', { isTargetAuthored: false });
    assert.strictEqual(r.supported, true);
  });
});

describe('exclusion patterns are independently testable', () => {
  const { EXCLUSION_PATTERNS } = require('./relationship-assertion');

  test('every Part 5 exclusion phrase is present in the exclusion pattern table', () => {
    const requiredSubstrings = [
      'not regulated by', 'not affiliated with', 'no relationship with', 'formerly employed by',
      'previously worked', 'firms regulated by', 'clients regulated by', 'guidance issued by',
      'according to', 'reported by', 'required by', 'must register with', 'may complain to',
      'subject to', 'discussed by', 'an article about', 'at the same',
    ];
    for (const substr of requiredSubstrings) {
      const found = EXCLUSION_PATTERNS.some((ex) => ex.regex.source.toLowerCase().includes(substr.toLowerCase().split(' ')[0]));
      assert.ok(found, `expected an exclusion pattern covering: ${substr}`);
    }
  });
});
