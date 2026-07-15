'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractEvidence } = require('./extract-evidence');

function page(overrides) {
  return {
    title: 'Acme Widgets Limited', canonicalUrl: null, metaDescription: '', visibleText: '', headings: [],
    internalLinks: [], externalLinks: [], jsonLd: [], footerText: '', navigationLabels: [],
    ...overrides,
  };
}

test('extractEvidence: company number via regex near "company number"', () => {
  const p = page({ visibleText: 'Acme Widgets Limited. Company number: 01234567. All rights reserved.' });
  const evidence = extractEvidence(p, { businessName: 'Acme Widgets Limited', categoryKeywords: [] });
  assert.equal(evidence.companyNumber, '01234567');
});

test('extractEvidence: company number via jsonLd Organization.identifier', () => {
  const p = page({ jsonLd: [{ '@type': 'Organization', name: 'Acme Widgets Limited', identifier: '7654321' }] });
  const evidence = extractEvidence(p, { businessName: 'Acme Widgets Limited', categoryKeywords: [] });
  assert.equal(evidence.companyNumber, '7654321');
});

test('extractEvidence: legal/trading name via title token-overlap', () => {
  const p = page({ title: 'Acme Widgets Limited | Home' });
  const evidence = extractEvidence(p, { businessName: 'Acme Widgets Limited', categoryKeywords: [] });
  assert.equal(evidence.legalName, 'Acme Widgets Limited | Home');
});

test('extractEvidence: no name overlap -> legalName null', () => {
  const p = page({ title: 'Completely Unrelated Site' });
  const evidence = extractEvidence(p, { businessName: 'Acme Widgets Limited', categoryKeywords: [] });
  assert.equal(evidence.legalName, null);
});

test('extractEvidence: postcode via UK regex on visible text', () => {
  const p = page({ visibleText: 'Find us at 1 High Street, SW1A 1AA, London.' });
  const evidence = extractEvidence(p, { businessName: 'Acme', categoryKeywords: [] });
  assert.equal(evidence.postcodeFound, 'SW1A 1AA');
});

test('extractEvidence: address requires postcode + nearby street keyword', () => {
  const p = page({ visibleText: 'Visit us at 1 High Street, SW1A 1AA, London.' });
  const evidence = extractEvidence(p, { businessName: 'Acme', categoryKeywords: [] });
  assert.ok(evidence.addressFound && evidence.addressFound.includes('High Street'));
});

test('extractEvidence: postcode present without street keyword nearby -> no address', () => {
  const p = page({ visibleText: 'Postcode: SW1A 1AA' });
  const evidence = extractEvidence(p, { businessName: 'Acme', categoryKeywords: [] });
  assert.equal(evidence.addressFound, null);
});

test('extractEvidence: UK telephone regex', () => {
  const p = page({ visibleText: 'Call us on 020 7946 0958 for enquiries.' });
  const evidence = extractEvidence(p, { businessName: 'Acme', categoryKeywords: [] });
  assert.ok(evidence.telephoneFound);
});

test('extractEvidence: principals via jsonLd Person entries, nullable', () => {
  const withPeople = page({ jsonLd: [{ '@type': 'Person', name: 'Jane Smith', jobTitle: 'Director' }] });
  const evidence = extractEvidence(withPeople, { businessName: 'Acme', categoryKeywords: [] });
  assert.deepEqual(evidence.principals, [{ name: 'Jane Smith', jobTitle: 'Director' }]);

  const withoutPeople = page({});
  const evidence2 = extractEvidence(withoutPeople, { businessName: 'Acme', categoryKeywords: [] });
  assert.equal(evidence2.principals, null);
});

test('extractEvidence: category consistency checks page text against candidate category keywords', () => {
  const p = page({ visibleText: 'We are a leading firm of chartered accountants.' });
  const consistent = extractEvidence(p, { businessName: 'Acme', categoryKeywords: ['ACCOUNTAN'] });
  assert.equal(consistent.categoryConsistency, true);
  const inconsistent = extractEvidence(p, { businessName: 'Acme', categoryKeywords: ['JEWELLER'] });
  assert.equal(inconsistent.categoryConsistency, false);
});
