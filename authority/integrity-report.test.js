'use strict';

// integrity-report.test.js — proves the report's measurement logic on synthetic
// rows. The real dataset (correctly) exercises none of the failure paths —
// 0 collisions, no algorithm change — so those must be tested with hand-built
// inputs, or they would never be verified at all.

const { test } = require('node:test');
const assert = require('node:assert');

const { computeMetrics, assessHealth, compareToPrevious } = require('./integrity-report');
const Identity = require('../organisation/identity');

// A row whose id is correctly derived from its own fields, so it counts as
// reconstructable unless we deliberately break it.
function row(overrides = {}) {
  const identifiers = Object.assign(
    { frn: null, praIdentifier: null, sraIdentifier: null, ukprn: null, companiesHouseNumber: null, lei: null },
    overrides.identifiers || {}
  );
  const normalisedName = overrides.normalisedName || 'ACME';
  const verifiedDomain = overrides.verifiedDomain || null;
  const candidateDomains = overrides.candidateDomains || (verifiedDomain ? [{ domain: verifiedDomain }] : []);
  const domain = verifiedDomain || (candidateDomains[0] && candidateDomains[0].domain) || null;
  const organisationId = overrides.organisationId || Identity.canonicalOrgId({
    companiesHouseNumber: identifiers.companiesHouseNumber,
    frn: identifiers.frn,
    sraNumber: identifiers.sraIdentifier,
    ukprn: identifiers.ukprn,
    ifUuid: null,
    normalisedName,
    domain,
  });
  return {
    organisationId,
    organisationName: overrides.organisationName || normalisedName,
    normalisedName,
    identifiers,
    verifiedDomain,
    candidateDomains,
  };
}

test('clean dataset: zero collisions, 100% reconstructable, healthy', () => {
  const rows = [
    row({ identifiers: { companiesHouseNumber: '01234567' } }),
    row({ identifiers: { sraIdentifier: '111111' }, normalisedName: 'BETA' }),
  ];
  const m = computeMetrics(rows);
  assert.strictEqual(m.identityIntegrity.strongIdentifierCollisions, 0);
  assert.strictEqual(m.reconstructability.reconstructablePercent, 100);
  const h = assessHealth(m);
  assert.strictEqual(h.overall, 'PASS');
});

test('strong-identifier collision is detected and drives CRITICAL health', () => {
  // Two different canonical ids sharing one Companies House number — the one
  // thing that must never happen. Force distinct ids so they are two records.
  const a = row({ organisationId: 'ORG-AAAAAAAAAAAA', identifiers: { companiesHouseNumber: '09999999' } });
  const b = row({ organisationId: 'ORG-BBBBBBBBBBBB', identifiers: { companiesHouseNumber: '09999999' } });
  const m = computeMetrics([a, b]);
  assert.strictEqual(m.identityIntegrity.strongIdentifierCollisions, 1);
  assert.strictEqual(m.identityIntegrity.collisionDetail[0].identifier, 'companies-house:09999999');
  const h = assessHealth(m);
  assert.strictEqual(h.overall, 'CRITICAL');
});

test('non-reconstructable record is counted with the right reason', () => {
  // An id that cannot be derived from published fields (simulating the ifUuid
  // tier): give it a domain but an id that does not match name+domain.
  const bad = row({ organisationId: 'ORG-DEADBEEF0000', verifiedDomain: 'x.example', normalisedName: 'X' });
  const m = computeMetrics([bad]);
  assert.strictEqual(m.reconstructability.nonReconstructable, 1);
  assert.ok(m.reconstructability.reasons['unexported-identity-input (ifUuid or pre-resolution domain)'] >= 1);
});

test('identity review group: same name+domain, distinct ids, classified by pattern', () => {
  const a = row({ organisationId: 'ORG-1111', identifiers: { sraIdentifier: '200000' }, normalisedName: 'DUPCO', verifiedDomain: 'dup.example' });
  const b = row({ organisationId: 'ORG-2222', identifiers: { sraIdentifier: '300000' }, normalisedName: 'DUPCO', verifiedDomain: 'dup.example' });
  const m = computeMetrics([a, b]);
  assert.strictEqual(m.transparency.identityReviewGroups, 1);
  assert.strictEqual(m.transparency.recordsRequiringGovernedReview, 2);
  assert.strictEqual(m.transparency.reviewGroupPatterns['distinct-strong-identifiers'], 1);
});

test('reconstructability health bands: 99.5% GOOD, sub-95% CONCERN', () => {
  const good = { identityIntegrity: { strongIdentifierCollisions: 0 }, reconstructability: { reconstructablePercent: 99.5 }, transparency: { identityReviewGroups: 0 } };
  assert.strictEqual(assessHealth(good).overall, 'GOOD');
  const concern = { identityIntegrity: { strongIdentifierCollisions: 0 }, reconstructability: { reconstructablePercent: 90 }, transparency: { identityReviewGroups: 0 } };
  assert.strictEqual(assessHealth(concern).overall, 'CONCERN');
});

test('historical comparison: same dataset SHA reports no comparison (idempotent re-audit)', () => {
  const m = computeMetrics([row({ identifiers: { sraIdentifier: '111111' } })]);
  const prev = { datasetSha256: 'SHA-A', generatedAt: 't0', metrics: m };
  const cmp = compareToPrevious(m, 'SHA-A', prev);
  assert.strictEqual(cmp.available, false);
});

test('historical comparison: genuine build-to-build deltas are computed', () => {
  const prevMetrics = computeMetrics([
    row({ identifiers: { sraIdentifier: '111111' }, normalisedName: 'A' }),
    row({ identifiers: { sraIdentifier: '222222' }, normalisedName: 'B' }),
  ]);
  const currMetrics = computeMetrics([
    row({ identifiers: { sraIdentifier: '111111' }, normalisedName: 'A' }),
  ]);
  const cmp = compareToPrevious(currMetrics, 'SHA-NEW', { datasetSha256: 'SHA-OLD', generatedAt: 't0', metrics: prevMetrics });
  assert.strictEqual(cmp.available, true);
  assert.strictEqual(cmp.changes.totalOrganisations, -1);
  assert.strictEqual(cmp.changes.identityAlgorithmChanged, false);
});

test('historical comparison: an identity-algorithm change is flagged (the most important signal)', () => {
  const m = computeMetrics([row({ identifiers: { sraIdentifier: '111111' } })]);
  const prevMetricsAltered = JSON.parse(JSON.stringify(m));
  prevMetricsAltered.identityIntegrity.identityAlgorithmFingerprint = 'DIFFERENT_FINGERPRINT';
  const cmp = compareToPrevious(m, 'SHA-NEW', { datasetSha256: 'SHA-OLD', generatedAt: 't0', metrics: prevMetricsAltered });
  assert.strictEqual(cmp.changes.identityAlgorithmChanged, true);
});
