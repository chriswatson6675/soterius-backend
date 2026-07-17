'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { canonicaliseUrl, canonicaliseActionKey } = require('./action-key');

describe('canonicaliseUrl', () => {
  test('collapses www/non-www', () => {
    assert.strictEqual(canonicaliseUrl('https://www.gov.uk/'), canonicaliseUrl('https://gov.uk/'));
  });

  test('collapses a trailing slash on a non-root path', () => {
    assert.strictEqual(canonicaliseUrl('https://example.com/about/'), canonicaliseUrl('https://example.com/about'));
  });

  test('collapses root path with or without a trailing slash', () => {
    assert.strictEqual(canonicaliseUrl('https://gov.uk'), canonicaliseUrl('https://gov.uk/'));
  });

  test('removes the fragment', () => {
    assert.strictEqual(canonicaliseUrl('https://example.com/page#section-2'), canonicaliseUrl('https://example.com/page'));
  });

  test('collapses http and https for the same host/path (canonical key only, not the real request)', () => {
    assert.strictEqual(canonicaliseUrl('http://gov.uk/guidance'), canonicaliseUrl('https://gov.uk/guidance'));
  });

  test('ignores tracking-only query parameters', () => {
    assert.strictEqual(
      canonicaliseUrl('https://example.com/page?utm_source=newsletter&utm_medium=email'),
      canonicaliseUrl('https://example.com/page')
    );
  });

  test('preserves meaningful query parameters that change content', () => {
    assert.notStrictEqual(
      canonicaliseUrl('https://find-and-update.company-information.service.gov.uk/company/09133668?tab=officers'),
      canonicaliseUrl('https://find-and-update.company-information.service.gov.uk/company/09133668')
    );
  });

  test('is order-insensitive for kept query parameters', () => {
    assert.strictEqual(
      canonicaliseUrl('https://example.com/search?b=2&a=1'),
      canonicaliseUrl('https://example.com/search?a=1&b=2')
    );
  });

  test('distinguishes genuinely different paths on the same domain', () => {
    const overview = canonicaliseUrl('https://find-and-update.company-information.service.gov.uk/company/09133668');
    const officers = canonicaliseUrl('https://find-and-update.company-information.service.gov.uk/company/09133668/officers');
    assert.notStrictEqual(overview, officers);
  });

  test('returns null for an unparseable URL', () => {
    assert.strictEqual(canonicaliseUrl('not a url'), null);
  });

  test('returns null for a non-http(s) protocol', () => {
    assert.strictEqual(canonicaliseUrl('ftp://example.com/file'), null);
    assert.strictEqual(canonicaliseUrl('mailto:someone@example.com'), null);
  });
});

describe('canonicaliseActionKey', () => {
  test('fetch_web_page keys by canonical URL', () => {
    const a = canonicaliseActionKey({ toolName: 'fetch_web_page', toolInput: { url: 'https://www.gov.uk/' } });
    const b = canonicaliseActionKey({ toolName: 'fetch_web_page', toolInput: { url: 'https://gov.uk' } });
    assert.strictEqual(a, b);
  });

  test('never treats a companies_house_lookup and a fetch_web_page of the register page as the same action', () => {
    const lookup = canonicaliseActionKey({ toolName: 'companies_house_lookup', toolInput: { name: 'Compliance Office' } });
    const fetch = canonicaliseActionKey({ toolName: 'fetch_web_page', toolInput: { url: 'https://find-and-update.company-information.service.gov.uk/company/09133668' } });
    assert.notStrictEqual(lookup, fetch);
  });

  test('register lookups key by tool name plus normalised name', () => {
    const a = canonicaliseActionKey({ toolName: 'companies_house_lookup', toolInput: { name: '  Compliance Office  ' } });
    const b = canonicaliseActionKey({ toolName: 'companies_house_lookup', toolInput: { name: 'compliance office' } });
    assert.strictEqual(a, b);
  });

  test('search_web keys by normalised query text', () => {
    const a = canonicaliseActionKey({ toolName: 'search_web', toolInput: { query: '  "Compliance Office"  services ' } });
    const b = canonicaliseActionKey({ toolName: 'search_web', toolInput: { query: '"Compliance Office" services' } });
    assert.strictEqual(a, b);
  });
});
