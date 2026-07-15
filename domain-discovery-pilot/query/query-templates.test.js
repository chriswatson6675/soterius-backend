'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildQueries, EXCLUDED_DOMAINS, isExcludedDomain, QUERY_TEMPLATE_VERSION } = require('./query-templates');

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

test('EXCLUDED_DOMAINS: contains the fixed exclusion list', () => {
  assert.ok(EXCLUDED_DOMAINS.includes('companieshouse.gov.uk'));
  assert.ok(EXCLUDED_DOMAINS.includes('linkedin.com'));
  assert.ok(EXCLUDED_DOMAINS.includes('opencorporates.com'));
  assert.equal(EXCLUDED_DOMAINS.length, 17);
});

test('isExcludedDomain: matches exact and subdomain', () => {
  assert.equal(isExcludedDomain('linkedin.com'), true);
  assert.equal(isExcludedDomain('uk.linkedin.com'), true);
  assert.equal(isExcludedDomain('acme-widgets.com'), false);
});

test('QUERY_TEMPLATE_VERSION is DDP-QT-v1.0', () => {
  assert.equal(QUERY_TEMPLATE_VERSION, 'DDP-QT-v1.0');
});
