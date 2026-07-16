'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildQueries, EXCLUDED_DOMAINS, EXCLUSION_LIST_VERSION, isExcludedDomain, QUERY_TEMPLATE_VERSION } = require('./query-templates');
const { normaliseDomain } = require('../../authority/lib/normalise');

test('buildQueries: two templates, postcode present', () => {
  const queries = buildQueries({ businessName: 'Acme Ltd', postcode: 'SW1A 1AA' });
  assert.equal(queries.length, 2);
  assert.equal(queries[0].query, '"Acme Ltd" SW1A 1AA');
  assert.equal(queries[1].query, '"Acme Ltd" official website');
  assert.equal(queries[0].templateId, 'DDP-QT-1');
  assert.equal(queries[1].templateId, 'DDP-QT-2');
});

test('buildQueries: falls back to just businessName when no postcode', () => {
  const queries = buildQueries({ businessName: 'Acme Ltd', postcode: '' });
  assert.equal(queries[0].query, '"Acme Ltd"');
});

test('EXCLUDED_DOMAINS: contains the fixed exclusion list, including the v1.1 additions from the live smoke test', () => {
  assert.ok(EXCLUDED_DOMAINS.includes('companieshouse.gov.uk'));
  assert.ok(EXCLUDED_DOMAINS.includes('linkedin.com'));
  assert.ok(EXCLUDED_DOMAINS.includes('opencorporates.com'));
  assert.ok(EXCLUDED_DOMAINS.includes('dnb.com'));
  assert.ok(EXCLUDED_DOMAINS.includes('ico.org.uk'));
  assert.ok(EXCLUDED_DOMAINS.includes('privco.com'));
  assert.ok(EXCLUDED_DOMAINS.includes('cylex-uk.co.uk'));
  assert.equal(EXCLUDED_DOMAINS.length, 21);
});

test('EXCLUSION_LIST_VERSION is DDP-EXCL-v1.1', () => {
  assert.equal(EXCLUSION_LIST_VERSION, 'DDP-EXCL-v1.1');
});

test('isExcludedDomain: matches exact and subdomain', () => {
  assert.equal(isExcludedDomain('linkedin.com'), true);
  assert.equal(isExcludedDomain('uk.linkedin.com'), true);
  assert.equal(isExcludedDomain('acme-widgets.com'), false);
});

// ── C: host-pattern exclusion coverage (five-record smoke test fix) ──────

test('isExcludedDomain: exact host match for every v1.1 addition', () => {
  assert.equal(isExcludedDomain('dnb.com'), true);
  assert.equal(isExcludedDomain('ico.org.uk'), true);
  assert.equal(isExcludedDomain('privco.com'), true);
  assert.equal(isExcludedDomain('cylex-uk.co.uk'), true);
});

test('isExcludedDomain: subdomain match, including the exact case the smoke test surfaced (shrewsbury.cylex-uk.co.uk)', () => {
  assert.equal(isExcludedDomain('shrewsbury.cylex-uk.co.uk'), true);
  assert.equal(isExcludedDomain('london.cylex-uk.co.uk'), true);
  assert.equal(isExcludedDomain('www.dnb.com'), true);
  assert.equal(isExcludedDomain('data.ico.org.uk'), true);
});

test('isExcludedDomain: lookalike domains must NOT be excluded (no substring false positives)', () => {
  assert.equal(isExcludedDomain('notdnb.com'), false);
  assert.equal(isExcludedDomain('dnb.com.evil.com'), false);
  assert.equal(isExcludedDomain('mydnb.com'), false);
  assert.equal(isExcludedDomain('ico.org.uk.attacker.net'), false);
  assert.equal(isExcludedDomain('privco.company'), false);
  assert.equal(isExcludedDomain('cylex-uk.co.uk.co'), false);
});

test('isExcludedDomain: case-insensitive as defense-in-depth, even though callers normalise first', () => {
  assert.equal(isExcludedDomain('DNB.COM'), true);
  assert.equal(isExcludedDomain('Shrewsbury.Cylex-UK.co.UK'), true);
});

test('isExcludedDomain + normaliseDomain: full pipeline excludes a real-world URL with scheme, www, path, and mixed case', () => {
  const normalised = normaliseDomain('https://WWW.DNB.COM/company/12345/profile?x=1');
  assert.equal(normalised, 'dnb.com');
  assert.equal(isExcludedDomain(normalised), true);
});

test('isExcludedDomain + normaliseDomain: a genuine business domain with a similar-looking path survives the pipeline', () => {
  const normalised = normaliseDomain('https://www.acme-widgets.co.uk/about/dnb-partnership');
  assert.equal(normalised, 'acme-widgets.co.uk');
  assert.equal(isExcludedDomain(normalised), false);
});

test('QUERY_TEMPLATE_VERSION is DDP-QT-v1.0', () => {
  assert.equal(QUERY_TEMPLATE_VERSION, 'DDP-QT-v1.0');
});
