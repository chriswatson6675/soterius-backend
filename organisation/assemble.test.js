'use strict';

// assemble.test.js — covers the GCN-004 register-identifier passthrough
// added to assembleFromFacts per ENG-030 §2 item 9 (frcAudit/hmrcAml/pbsFirm,
// mirroring the pre-existing `frn` pattern: no live adapter exists for any of
// these, so the fact is recorded as corroborated, not independently verified).
// Uses only inputs that skip every live-adapter branch (no sraNumber,
// companiesHouseNumber, frn, or domain), so no network/adapter mocking is
// needed to test this in isolation.

const { test } = require('node:test');
const assert = require('node:assert');

const { assembleFromFacts } = require('./assemble');

test('assembleFromFacts records an hmrcAml-only organisation with a corroborated regulator fact', async () => {
  const result = await assembleFromFacts({ hmrcAml: '12137104', name: 'Post Office Limited' }, 'ORG-TEST-HMRCAML');
  assert.strictEqual(result.ok, true);
  const org = result.organisation;
  assert.deepStrictEqual(
    org.identifiers.find((i) => i.scheme === 'uk.hmrc.amlregistration'),
    { scheme: 'uk.hmrc.amlregistration', value: '12137104', primary: true }
  );
  assert.deepStrictEqual(
    org.regulators.find((r) => r.regulator === 'HMRC'),
    { regulator: 'HMRC', identifier: '12137104', status: null }
  );
  const prov = org.provenance.find((p) => p.source === 'authority-dataset' && p.confidence === 'corroborated');
  assert.ok(prov, 'expected a corroborated authority-dataset provenance entry');
});

test('assembleFromFacts marks the strongest-present GCN-004 identifier primary, in precedence order', async () => {
  const result = await assembleFromFacts(
    { frcAudit: 'C001234', hmrcAml: '12137104', pbsFirm: 'PBS-1', name: 'Test Firm' },
    'ORG-TEST-MULTI'
  );
  const ids = result.organisation.identifiers;
  assert.strictEqual(ids.find((i) => i.scheme === 'uk.frc.auditfirm').primary, true);
  assert.strictEqual(ids.find((i) => i.scheme === 'uk.hmrc.amlregistration').primary, false);
  assert.strictEqual(ids.find((i) => i.scheme === 'uk.pbs.firmid').primary, false);
});

test('assembleFromFacts never records a GCN-004 identifier fact when none is supplied', async () => {
  const result = await assembleFromFacts({ name: 'No Identifiers Ltd' }, 'ORG-TEST-NONE');
  const schemes = result.organisation.identifiers.map((i) => i.scheme);
  assert.ok(!schemes.includes('uk.frc.auditfirm'));
  assert.ok(!schemes.includes('uk.hmrc.amlregistration'));
  assert.ok(!schemes.includes('uk.pbs.firmid'));
});

test('assembleFromFacts still marks companiesHouseNumber primary over an hmrcAml value (existing precedence unaffected)', async () => {
  const result = await assembleFromFacts(
    { companiesHouseNumber: 'OC399969', hmrcAml: '12137104', name: 'Test Firm' },
    'ORG-TEST-CH-OUTRANKS'
  );
  const ids = result.organisation.identifiers;
  assert.strictEqual(ids.find((i) => i.scheme === 'uk.companieshouse.number').primary, true);
  assert.strictEqual(ids.find((i) => i.scheme === 'uk.hmrc.amlregistration').primary, false);
});
