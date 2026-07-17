'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalCoPartyKey, mergeDiscoveriesByCanonicalKey, registrableDomainOf } = require('./co-party-identity');

describe('registrableDomainOf', () => {
  test('resolves a full URL to its registrable domain', () => {
    assert.strictEqual(registrableDomainOf('https://www.gov.uk/some/deep/path'), 'gov.uk');
  });

  test('resolves a bare hostname the same way', () => {
    assert.strictEqual(registrableDomainOf('www.nationalcrimeagency.gov.uk'), 'nationalcrimeagency.gov.uk');
  });

  test('returns null for garbage input', () => {
    assert.strictEqual(registrableDomainOf(''), null);
    assert.strictEqual(registrableDomainOf(null), null);
  });
});

describe('canonicalCoPartyKey — priority order', () => {
  test('an explicit domain wins even if a different name/url is also supplied', () => {
    const result = canonicalCoPartyKey({ domain: 'sra.org.uk', url: 'https://example.com/', name: 'Something Else' });
    assert.strictEqual(result.key, 'sra.org.uk');
    assert.strictEqual(result.basis, 'domain');
  });

  test('falls back to the fetched final URL registrable domain when no explicit domain is given', () => {
    const result = canonicalCoPartyKey({ url: 'https://www.nationalcrimeagency.gov.uk/some-page', name: 'here' });
    assert.strictEqual(result.key, 'nationalcrimeagency.gov.uk');
    assert.strictEqual(result.basis, 'final_url_domain');
  });

  test('falls back to a known organisation identifier when no domain/url resolves', () => {
    const result = canonicalCoPartyKey({ organisationIdentifier: '12345678', name: 'Some Firm' });
    assert.strictEqual(result.key, 'id:12345678');
    assert.strictEqual(result.basis, 'identifier');
  });

  test('falls back to normalised name only as a last resort', () => {
    const result = canonicalCoPartyKey({ name: 'Acme Compliance Ltd' });
    assert.strictEqual(result.basis, 'name');
    assert.match(result.key, /^name:/);
  });

  test('rejects a social-media domain outright, even as the only signal available', () => {
    const result = canonicalCoPartyKey({ domain: 'linkedin.com', name: 'Compliance Office on LinkedIn' });
    assert.strictEqual(result.rejected, true);
    assert.strictEqual(result.key, null);
  });

  test('two genuinely different organisations on the same hosting platform are not merged', () => {
    // Same platform host is never the key — each has its own registrable domain.
    const a = canonicalCoPartyKey({ domain: 'firm-a.squarespace.com' });
    const b = canonicalCoPartyKey({ domain: 'firm-b.squarespace.com' });
    assert.notStrictEqual(a.key, b.key);
  });
});

describe('mergeDiscoveriesByCanonicalKey', () => {
  test('different labels resolving to the same domain merge into one co-party, preserving aliases', () => {
    const discoveries = [
      { discoveredName: 'here', discoveredDomain: 'gov.uk', discoveredDomainNormalised: 'gov.uk' },
      { discoveredName: 'published in June', discoveredDomain: 'gov.uk', discoveredDomainNormalised: 'gov.uk' },
    ];
    const merged = mergeDiscoveriesByCanonicalKey(discoveries);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].primaryName, 'here');
    assert.deepStrictEqual(merged[0].aliases, ['published in June']);
  });

  test('two different paths on the same registrable domain merge into one co-party', () => {
    const discoveries = [
      { discoveredName: 'NCA guidance', discoveredDomain: 'www.nationalcrimeagency.gov.uk', discoveredDomainNormalised: 'nationalcrimeagency.gov.uk' },
      { discoveredName: 'NCA news', discoveredDomain: 'nationalcrimeagency.gov.uk/news', discoveredDomainNormalised: 'nationalcrimeagency.gov.uk' },
    ];
    const merged = mergeDiscoveriesByCanonicalKey(discoveries);
    assert.strictEqual(merged.length, 1);
  });

  test('the same organisation name under two different domains is NOT merged', () => {
    const discoveries = [
      { discoveredName: 'Example Consultancy', discoveredDomain: 'example-consultancy.co.uk', discoveredDomainNormalised: 'example-consultancy.co.uk' },
      { discoveredName: 'Example Consultancy', discoveredDomain: 'example-consultancy.com', discoveredDomainNormalised: 'example-consultancy.com' },
    ];
    const merged = mergeDiscoveriesByCanonicalKey(discoveries);
    assert.strictEqual(merged.length, 2);
  });

  test('a discovery with no domain falls back to name-based grouping', () => {
    const discoveries = [
      { discoveredName: 'Acme Compliance Ltd', discoveredDomain: null, discoveredDomainNormalised: null },
      { discoveredName: 'Acme Compliance Ltd', discoveredDomain: null, discoveredDomainNormalised: null },
    ];
    const merged = mergeDiscoveriesByCanonicalKey(discoveries);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].basis, 'name');
  });

  test('social-platform discoveries are excluded from co-party grouping entirely', () => {
    const discoveries = [{ discoveredName: 'Compliance Office LinkedIn', discoveredDomain: 'linkedin.com', discoveredDomainNormalised: 'linkedin.com' }];
    const merged = mergeDiscoveriesByCanonicalKey(discoveries);
    assert.strictEqual(merged.length, 0);
  });
});
