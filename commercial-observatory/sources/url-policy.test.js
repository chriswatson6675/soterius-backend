'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  normaliseUrl, dedupeUrls, exceedsMaxUrlLength, isAllowedProtocol, hasRejectedExtension,
  isSameRegistrableDomain, isLocalHostname, isPrivateOrReservedIpv4, isPrivateOrReservedIpv6,
  resolveHostnameSafely, MAX_ADDITIONAL_PAGES, MAX_LINK_DEPTH,
} = require('./url-policy');

describe('normaliseUrl', () => {
  test('resolves a relative URL against a base', () => {
    assert.strictEqual(normaliseUrl('/about', 'https://example.com/'), 'https://example.com/about');
  });

  test('strips the fragment', () => {
    assert.strictEqual(normaliseUrl('https://example.com/about#team'), 'https://example.com/about');
  });

  test('lowercases the host but not the path', () => {
    assert.strictEqual(normaliseUrl('https://WWW.Example.com/About'), 'https://www.example.com/About');
  });

  test('strips a trailing slash from a non-root path', () => {
    assert.strictEqual(normaliseUrl('https://example.com/about/'), 'https://example.com/about');
  });

  test('keeps the root path as a single slash', () => {
    assert.strictEqual(normaliseUrl('https://example.com/'), 'https://example.com/');
  });

  test('returns null for an unparseable URL', () => {
    assert.strictEqual(normaliseUrl('not a url'), null);
  });
});

describe('dedupeUrls', () => {
  test('collapses equivalent URLs to one entry', () => {
    const result = dedupeUrls(['https://example.com/about', 'https://example.com/about/', 'https://EXAMPLE.com/about#x'], 'https://example.com/');
    assert.strictEqual(result.length, 1);
  });

  test('drops unparseable entries silently rather than throwing', () => {
    const result = dedupeUrls(['not a url', 'https://example.com/about']);
    assert.strictEqual(result.length, 1);
  });
});

describe('exceedsMaxUrlLength', () => {
  test('flags an excessively long URL', () => {
    assert.strictEqual(exceedsMaxUrlLength('https://example.com/' + 'a'.repeat(3000)), true);
  });

  test('accepts a normal-length URL', () => {
    assert.strictEqual(exceedsMaxUrlLength('https://example.com/about'), false);
  });
});

describe('isAllowedProtocol', () => {
  test('accepts http and https', () => {
    assert.strictEqual(isAllowedProtocol('http://example.com'), true);
    assert.strictEqual(isAllowedProtocol('https://example.com'), true);
  });

  test('rejects mailto, tel and javascript pseudo-protocols', () => {
    assert.strictEqual(isAllowedProtocol('mailto:someone@example.com'), false);
    assert.strictEqual(isAllowedProtocol('tel:+441234567890'), false);
    assert.strictEqual(isAllowedProtocol('javascript:alert(1)'), false);
  });
});

describe('hasRejectedExtension', () => {
  test('rejects a PDF, image and stylesheet path', () => {
    assert.strictEqual(hasRejectedExtension('https://example.com/brochure.pdf'), true);
    assert.strictEqual(hasRejectedExtension('https://example.com/logo.png'), true);
    assert.strictEqual(hasRejectedExtension('https://example.com/style.css'), true);
  });

  test('accepts a normal HTML page path', () => {
    assert.strictEqual(hasRejectedExtension('https://example.com/about'), false);
  });
});

describe('isSameRegistrableDomain', () => {
  test('a subdomain is the same registrable domain as its parent', () => {
    assert.strictEqual(isSameRegistrableDomain('https://www.example.co.uk/about', 'https://example.co.uk/'), true);
  });

  test('a different registrable domain is not the same site', () => {
    assert.strictEqual(isSameRegistrableDomain('https://otherdomain.com/about', 'https://example.co.uk/'), false);
  });

  test('accepts a bare root domain string as the comparison target', () => {
    assert.strictEqual(isSameRegistrableDomain('https://example.co.uk/about', 'example.co.uk'), true);
  });
});

describe('isLocalHostname', () => {
  test('rejects localhost and its subdomains', () => {
    assert.strictEqual(isLocalHostname('localhost'), true);
    assert.strictEqual(isLocalHostname('foo.localhost'), true);
  });

  test('accepts a normal public hostname', () => {
    assert.strictEqual(isLocalHostname('example.com'), false);
  });
});

describe('private/reserved IP detection', () => {
  test('rejects RFC1918 and loopback IPv4 ranges', () => {
    for (const ip of ['10.0.0.5', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.1.1', '0.0.0.0']) {
      assert.strictEqual(isPrivateOrReservedIpv4(ip), true, ip);
    }
  });

  test('accepts a public IPv4 address', () => {
    assert.strictEqual(isPrivateOrReservedIpv4('93.184.216.34'), false);
  });

  test('rejects IPv6 loopback and link-local/unique-local ranges', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
      assert.strictEqual(isPrivateOrReservedIpv6(ip), true, ip);
    }
  });

  test('rejects an IPv4-mapped private IPv6 address', () => {
    assert.strictEqual(isPrivateOrReservedIpv6('::ffff:127.0.0.1'), true);
  });
});

describe('resolveHostnameSafely (DNS-rebinding guard, injectable lookup)', () => {
  test('rejects a hostname that resolves to a private address', async () => {
    const fakeLookup = (hostname, opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);
    const result = await resolveHostnameSafely('sneaky.example.com', { lookup: fakeLookup });
    assert.strictEqual(result.safe, false);
    assert.strictEqual(result.reason, 'resolves_to_private_address');
  });

  test('accepts a hostname that resolves only to public addresses', async () => {
    const fakeLookup = (hostname, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
    const result = await resolveHostnameSafely('example.com', { lookup: fakeLookup });
    assert.strictEqual(result.safe, true);
  });

  test('treats a DNS resolution failure as unsafe, never throws', async () => {
    const fakeLookup = (hostname, opts, cb) => cb(new Error('ENOTFOUND'));
    const result = await resolveHostnameSafely('nonexistent.invalid', { lookup: fakeLookup });
    assert.strictEqual(result.safe, false);
    assert.strictEqual(result.reason, 'dns_resolution_failed');
  });

  test('rejects "localhost" before ever calling lookup', async () => {
    let called = false;
    const fakeLookup = (hostname, opts, cb) => { called = true; cb(null, [{ address: '93.184.216.34', family: 4 }]); };
    const result = await resolveHostnameSafely('localhost', { lookup: fakeLookup });
    assert.strictEqual(result.safe, false);
    assert.strictEqual(called, false);
  });
});

describe('MVP-0 limits', () => {
  test('additional-page and link-depth limits match the brief', () => {
    assert.strictEqual(MAX_ADDITIONAL_PAGES, 8);
    assert.strictEqual(MAX_LINK_DEPTH, 1);
  });
});
