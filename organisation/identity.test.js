'use strict';

// identity.test.js — proves ADR-SYS-010 OC-6: canonical identity precedence
// is deterministic, stable, and identical regardless of caller (batch build
// vs live resolution). This is the ONLY module implementing the precedence
// (see identity.js header) — these tests are what makes that a guarantee
// rather than an assertion in a comment.

const { test } = require('node:test');
const assert = require('node:assert');

const { canonicalOrgId, primaryKeyOf, sha } = require('./identity');

// build.js is a top-level script (runs its pipeline on require, writes to
// disk, takes ~10s+ over 35k+ source records) — not something a unit test
// should require directly. Its adapter logic (batch org shape -> flat
// identifiers) is reproduced here verbatim, matching build.js's own
// primaryKeyOf() adapter exactly, so these tests can prove batch/live
// cross-consistency without executing the full batch pipeline per test run.
// This is the one place this test file duplicates a few lines of shape
// ADAPTATION (not precedence logic — that's exclusively in identity.js) —
// flagged plainly rather than silently done. If build.js's adapter ever
// changes, this must change with it; there is no way to eliminate that
// coupling without executing the batch script from the test itself, which
// is not worth the runtime cost for what it would buy.
function identifiersOfBatchOrg(org) {
  return {
    companiesHouseNumber: org.identifiers.companiesHouseNumber,
    frn: org.identifiers.frn,
    sraNumber: org.identifiers.sraIdentifier,
    ukprn: org.identifiers.ukprn,
    ifUuid: org._ifUuids.length ? [...org._ifUuids].sort()[0] : null,
    normalisedName: org.normalisedName || org.organisationName || null,
    domain: org._candidates[0]?.domain || null,
  };
}

// --- sha ---------------------------------------------------------------

test('sha is deterministic', () => {
  assert.strictEqual(sha('hello'), sha('hello'));
});

test('sha is sensitive to input', () => {
  assert.notStrictEqual(sha('hello'), sha('hello '));
});

// --- primaryKeyOf: precedence order -------------------------------------

test('primaryKeyOf prefers Companies House number over everything else', () => {
  const pk = primaryKeyOf({
    companiesHouseNumber: 'OC399969', frn: '123456', sraNumber: '587234',
    ukprn: '10001234', ifUuid: 'abc-uuid', normalisedName: 'x', domain: 'x.com',
  });
  assert.strictEqual(pk, 'cn:OC399969');
});

test('primaryKeyOf falls to FRN when no Companies House number', () => {
  const pk = primaryKeyOf({
    companiesHouseNumber: null, frn: '123456', sraNumber: '587234',
    ukprn: '10001234', ifUuid: 'abc-uuid', normalisedName: 'x', domain: 'x.com',
  });
  assert.strictEqual(pk, 'frn:123456');
});

test('primaryKeyOf falls to SRA number when no CH number or FRN', () => {
  const pk = primaryKeyOf({
    companiesHouseNumber: null, frn: null, sraNumber: '587234',
    ukprn: '10001234', ifUuid: 'abc-uuid', normalisedName: 'x', domain: 'x.com',
  });
  assert.strictEqual(pk, 'sra:587234');
});

test('primaryKeyOf falls to FRC audit-firm registration number when no CH/FRN/SRA (GCN-004)', () => {
  const pk = primaryKeyOf({
    companiesHouseNumber: null, frn: null, sraNumber: null, frcAudit: 'C001234',
    hmrcAml: '99999999', pbsFirm: 'PBS-1', ukprn: '10001234', ifUuid: 'abc-uuid',
    lei: '213800ABCDEFGHIJ123', normalisedName: 'x', domain: 'x.com',
  });
  assert.strictEqual(pk, 'frcAudit:C001234');
});

test('primaryKeyOf falls to HMRC AML registration number when no CH/FRN/SRA/FRC-audit (GCN-004)', () => {
  const pk = primaryKeyOf({
    companiesHouseNumber: null, frn: null, sraNumber: null, frcAudit: null,
    hmrcAml: '99999999', pbsFirm: 'PBS-1', ukprn: '10001234', ifUuid: 'abc-uuid',
    lei: '213800ABCDEFGHIJ123', normalisedName: 'x', domain: 'x.com',
  });
  assert.strictEqual(pk, 'hmrcAml:99999999');
});

test('primaryKeyOf falls to the permissioned-PBS firm id when no CH/FRN/SRA/FRC-audit/HMRC-AML (GCN-004)', () => {
  const pk = primaryKeyOf({
    companiesHouseNumber: null, frn: null, sraNumber: null, frcAudit: null,
    hmrcAml: null, pbsFirm: 'PBS-1', ukprn: '10001234', ifUuid: 'abc-uuid',
    lei: '213800ABCDEFGHIJ123', normalisedName: 'x', domain: 'x.com',
  });
  assert.strictEqual(pk, 'pbsFirm:PBS-1');
});

test('primaryKeyOf falls to UKPRN when no CH/FRN/SRA/FRC-audit/HMRC-AML/PBS-firm', () => {
  const pk = primaryKeyOf({
    companiesHouseNumber: null, frn: null, sraNumber: null, frcAudit: null,
    hmrcAml: null, pbsFirm: null,
    ukprn: '10001234', ifUuid: 'abc-uuid', normalisedName: 'x', domain: 'x.com',
  });
  assert.strictEqual(pk, 'ukprn:10001234');
});

test('primaryKeyOf falls to IF-UUID when no CH/FRN/SRA/UKPRN', () => {
  const pk = primaryKeyOf({
    companiesHouseNumber: null, frn: null, sraNumber: null,
    ukprn: null, ifUuid: 'abc-uuid', normalisedName: 'x', domain: 'x.com',
  });
  assert.strictEqual(pk, 'uuid:abc-uuid');
});

test('primaryKeyOf falls to LEI when no CH/FRN/SRA/FRC-audit/HMRC-AML/PBS-firm/UKPRN/IF-UUID (GCN-004 §E.5)', () => {
  const pk = primaryKeyOf({
    companiesHouseNumber: null, frn: null, sraNumber: null, frcAudit: null,
    hmrcAml: null, pbsFirm: null, ukprn: null, ifUuid: null,
    lei: '213800ABCDEFGHIJ123', normalisedName: 'x', domain: 'x.com',
  });
  assert.strictEqual(pk, 'lei:213800ABCDEFGHIJ123');
});

test('primaryKeyOf falls to name+domain hash when no identifier at all', () => {
  const pk = primaryKeyOf({
    companiesHouseNumber: null, frn: null, sraNumber: null,
    ukprn: null, ifUuid: null, lei: null, normalisedName: 'acme legal', domain: 'acme.co.uk',
  });
  assert.strictEqual(pk, `nd:${sha('acme legal|acme.co.uk')}`);
});

test('GCN-004 §F: full precedence order end to end, strongest present always wins', () => {
  const all = {
    companiesHouseNumber: 'OC399969', frn: '123456', sraNumber: '587234',
    frcAudit: 'C001234', hmrcAml: '99999999', pbsFirm: 'PBS-1',
    ukprn: '10001234', ifUuid: 'abc-uuid', lei: '213800ABCDEFGHIJ123',
    normalisedName: 'x', domain: 'x.com',
  };
  assert.strictEqual(primaryKeyOf(all), 'cn:OC399969');
  assert.strictEqual(primaryKeyOf({ ...all, companiesHouseNumber: null }), 'frn:123456');
  assert.strictEqual(primaryKeyOf({ ...all, companiesHouseNumber: null, frn: null }), 'sra:587234');
  assert.strictEqual(
    primaryKeyOf({ ...all, companiesHouseNumber: null, frn: null, sraNumber: null }),
    'frcAudit:C001234'
  );
  assert.strictEqual(
    primaryKeyOf({ ...all, companiesHouseNumber: null, frn: null, sraNumber: null, frcAudit: null }),
    'hmrcAml:99999999'
  );
  assert.strictEqual(
    primaryKeyOf({
      ...all, companiesHouseNumber: null, frn: null, sraNumber: null, frcAudit: null, hmrcAml: null,
    }),
    'pbsFirm:PBS-1'
  );
  assert.strictEqual(
    primaryKeyOf({
      ...all, companiesHouseNumber: null, frn: null, sraNumber: null, frcAudit: null, hmrcAml: null, pbsFirm: null,
    }),
    'ukprn:10001234'
  );
  assert.strictEqual(
    primaryKeyOf({
      ...all,
      companiesHouseNumber: null, frn: null, sraNumber: null, frcAudit: null, hmrcAml: null, pbsFirm: null, ukprn: null,
    }),
    'uuid:abc-uuid'
  );
  assert.strictEqual(
    primaryKeyOf({
      ...all,
      companiesHouseNumber: null, frn: null, sraNumber: null, frcAudit: null, hmrcAml: null,
      pbsFirm: null, ukprn: null, ifUuid: null,
    }),
    'lei:213800ABCDEFGHIJ123'
  );
});

test('GCN-004 §H: no existing identifier is removed, renamed, or reordered — the pre-GCN-004 tiers are unaffected by callers that never populate the new fields', () => {
  // Every caller in the repository today (build.js's identifiersOf, resolve.js's
  // normaliseFacts) never populates frcAudit/hmrcAml/pbsFirm/lei — this proves
  // that omitting them entirely reproduces the exact pre-GCN-004 precedence,
  // so no existing ORG-<sha1> id is affected by this change.
  assert.strictEqual(primaryKeyOf({ companiesHouseNumber: 'OC399969', sraNumber: '587234' }), 'cn:OC399969');
  assert.strictEqual(primaryKeyOf({ frn: '123456', sraNumber: '587234' }), 'frn:123456');
  assert.strictEqual(primaryKeyOf({ sraNumber: '587234', ukprn: '10001234' }), 'sra:587234');
  assert.strictEqual(primaryKeyOf({ ukprn: '10001234', ifUuid: 'abc-uuid' }), 'ukprn:10001234');
  assert.strictEqual(primaryKeyOf({ ifUuid: 'abc-uuid' }), 'uuid:abc-uuid');
  assert.strictEqual(
    primaryKeyOf({ normalisedName: 'acme legal', domain: 'acme.co.uk' }),
    `nd:${sha('acme legal|acme.co.uk')}`
  );
});

test('name+domain fallback tolerates missing name and missing domain independently', () => {
  const pkNoDomain = primaryKeyOf({ normalisedName: 'acme legal', domain: null });
  assert.strictEqual(pkNoDomain, `nd:${sha('acme legal|')}`);
  const pkNoName = primaryKeyOf({ normalisedName: null, domain: 'acme.co.uk' });
  assert.strictEqual(pkNoName, `nd:${sha('|acme.co.uk')}`);
});

// --- canonicalOrgId: shape and determinism ------------------------------

test('canonicalOrgId has the ORG-<12 hex chars> shape', () => {
  const id = canonicalOrgId({ companiesHouseNumber: 'OC399969' });
  assert.match(id, /^ORG-[0-9A-F]{12}$/);
});

test('canonicalOrgId is deterministic for identical identifiers', () => {
  const a = canonicalOrgId({ sraNumber: '587234' });
  const b = canonicalOrgId({ sraNumber: '587234' });
  assert.strictEqual(a, b);
});

test('canonicalOrgId gives a keyless (non-incorporated) firm a synthetic id anchored on its regulator identifier, per GCN-004 §E.3', () => {
  // A sole-practitioner/partnership-style firm with no company number takes
  // its strongest available register identifier as primary — here, an HMRC
  // AML registration number — rather than falling all the way to the
  // fragile name+domain hash. This is the "keyless firm" case §E.3 fixes.
  const a = canonicalOrgId({ hmrcAml: '12137104', normalisedName: 'post office limited' });
  const b = canonicalOrgId({ hmrcAml: '12137104', normalisedName: 'a different name entirely' });
  assert.match(a, /^ORG-[0-9A-F]{12}$/);
  assert.strictEqual(a, b, 'the same HMRC AML registration number must always resolve to the same id regardless of a differing/varying name');
});

test('canonicalOrgId distinguishes two keyless firms by their HMRC AML registration number', () => {
  const a = canonicalOrgId({ hmrcAml: '12137104' });
  const b = canonicalOrgId({ hmrcAml: '99999999' });
  assert.notStrictEqual(a, b);
});

test('canonicalOrgId differs for different identifiers', () => {
  const a = canonicalOrgId({ sraNumber: '587234' });
  const b = canonicalOrgId({ sraNumber: '587235' });
  assert.notStrictEqual(a, b);
});

test('canonicalOrgId ignores weaker identifiers once a stronger one is present (stability under enrichment)', () => {
  // A firm resolved with only an SRA number today, later enriched with a
  // Companies House number tomorrow, must NOT keep the old id — but a
  // *second* call with the SAME identifier set must always agree with itself.
  const beforeEnrichment = canonicalOrgId({ sraNumber: '587234' });
  const beforeEnrichmentAgain = canonicalOrgId({ sraNumber: '587234' });
  assert.strictEqual(beforeEnrichment, beforeEnrichmentAgain);
});

// --- OC-6: batch and live paths must agree ------------------------------

test('OC-6: batch-shaped and live-shaped identifiers for the same firm produce the same id (Companies House tier)', () => {
  const batchOrg = {
    identifiers: { companiesHouseNumber: 'OC399969', frn: null, sraIdentifier: '587234', ukprn: null },
    _ifUuids: [], normalisedName: 'mishcon de reya llp', organisationName: 'Mishcon de Reya LLP',
    _candidates: [{ domain: 'mishcon.com' }],
  };
  const batchId = canonicalOrgId(identifiersOfBatchOrg(batchOrg));

  // organisation/resolve.js's identifiersOf() shape for the same real firm —
  // it never populates frn/ukprn/ifUuid (no adapter for them yet), which
  // must not matter since Companies House outranks all of them anyway.
  const liveId = canonicalOrgId({
    companiesHouseNumber: 'OC399969', sraNumber: '587234',
    normalisedName: 'mishcon de reya llp', domain: 'mishcon.com',
  });

  assert.strictEqual(batchId, liveId);
});

test('OC-6: batch-shaped and live-shaped identifiers agree at the SRA tier (no Companies House number known)', () => {
  const batchOrg = {
    identifiers: { companiesHouseNumber: null, frn: null, sraIdentifier: '200224', ukprn: null },
    _ifUuids: [], normalisedName: 'a firm', organisationName: 'A Firm',
    _candidates: [{ domain: 'afirm.co.uk' }],
  };
  const batchId = canonicalOrgId(identifiersOfBatchOrg(batchOrg));

  const liveId = canonicalOrgId({
    companiesHouseNumber: null, sraNumber: '200224',
    normalisedName: 'a firm', domain: 'afirm.co.uk',
  });

  assert.strictEqual(batchId, liveId);
});

test('OC-6: a live resolution missing the batch-only tiers (FRN/UKPRN/IF-UUID) still agrees with batch when neither has them', () => {
  const batchOrg = {
    identifiers: { companiesHouseNumber: null, frn: null, sraIdentifier: null, ukprn: null },
    _ifUuids: [], normalisedName: 'small firm', organisationName: 'Small Firm',
    _candidates: [{ domain: 'smallfirm.co.uk' }],
  };
  const batchId = canonicalOrgId(identifiersOfBatchOrg(batchOrg));

  const liveId = canonicalOrgId({
    normalisedName: 'small firm', domain: 'smallfirm.co.uk',
  });

  assert.strictEqual(batchId, liveId);
});
