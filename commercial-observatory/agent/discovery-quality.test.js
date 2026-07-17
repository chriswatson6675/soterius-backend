'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { assessDiscoveryCandidate, domainToPlausibleName } = require('./discovery-quality');

describe('assessDiscoveryCandidate — rejects utility/navigation/legal noise', () => {
  const rejectCases = [
    'Follow this company', '© Crown copyright', 'Developers', 'Policies', 'Contact us',
    'here', 'Tell us what you think of this service', 'Sign in / Register',
    'Terms and conditions of sale', 'Privacy and cookies policy',
  ];
  for (const rawName of rejectCases) {
    test(`rejects "${rawName}"`, () => {
      const result = assessDiscoveryCandidate({ rawName, domain: 'example.com' });
      assert.strictEqual(result.accepted, false, `expected "${rawName}" to be rejected`);
    });
  }

  test('rejects "link opens in a new window/tab" UI phrasing', () => {
    const result = assessDiscoveryCandidate({ rawName: 'Developers Link opens in new tab', domain: 'gov.uk' });
    assert.strictEqual(result.accepted, false);
  });

  test('rejects cookie-information domains regardless of anchor text', () => {
    const result = assessDiscoveryCandidate({ rawName: 'www.aboutcookies.org', domain: 'aboutcookies.org' });
    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.category, 'cookie_resource');
  });

  test('rejects www.allaboutcookies.org', () => {
    const result = assessDiscoveryCandidate({ rawName: 'www.allaboutcookies.org', domain: 'allaboutcookies.org' });
    assert.strictEqual(result.accepted, false);
  });
});

describe('assessDiscoveryCandidate — identifier/reference-number is never a name', () => {
  test('rejects a registration-number-shaped token with no vendor context', () => {
    const result = assessDiscoveryCandidate({ rawName: 'ZA075078', domain: 'ico.org.uk', pageText: 'The Compliance Office is registered with the Information Commissioner\'s Office under registration number ZA075078.' });
    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.category, 'identifier_not_a_name');
  });

  test('never creates a discovery named after a purely numeric token', () => {
    const result = assessDiscoveryCandidate({ rawName: '12345678', domain: 'example.com' });
    assert.strictEqual(result.accepted, false);
  });
});

describe('assessDiscoveryCandidate — raw URL as anchor label', () => {
  test('rejects a raw URL label with no vendor context', () => {
    const result = assessDiscoveryCandidate({ rawName: 'https://www.example-random-site.com/', domain: 'example-random-site.com', pageText: 'Some unrelated page text.' });
    assert.strictEqual(result.accepted, false);
    assert.strictEqual(result.category, 'platform_endpoint');
  });

  test('accepts a raw URL label as a technology vendor when explicit sub-processor context exists (Clio)', () => {
    const pageText = 'Our sub-processors As at the time of writing our sub-processors for data protection purposes are as follows: https://www.clio.com/uk/ https://www.knack.com/';
    const result = assessDiscoveryCandidate({ rawName: 'https://www.clio.com/uk/', domain: 'clio.com', pageText });
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.category, 'technology_vendor');
    assert.strictEqual(result.name, 'Clio');
  });

  test('accepts Knack only where explicit service-provider/subprocessor context exists', () => {
    const pageText = 'Our sub-processors As at the time of writing our sub-processors for data protection purposes are as follows: https://www.clio.com/uk/ https://www.knack.com/';
    const result = assessDiscoveryCandidate({ rawName: 'https://www.knack.com/', domain: 'knack.com', pageText });
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.name, 'Knack');
  });

  test('rejects Knack-shaped raw URL when NO sub-processor/vendor context is present', () => {
    const result = assessDiscoveryCandidate({ rawName: 'https://www.knack.com/', domain: 'knack.com', pageText: 'Just a random mention with no vendor list context.' });
    assert.strictEqual(result.accepted, false);
  });

  test('the raw link label is never used as the derived name — the domain is', () => {
    const pageText = 'Our suppliers include: https://www.example-vendor.io/pricing';
    const result = assessDiscoveryCandidate({ rawName: 'https://www.example-vendor.io/pricing', domain: 'example-vendor.io', pageText });
    assert.strictEqual(result.accepted, true);
    assert.notStrictEqual(result.name, 'https://www.example-vendor.io/pricing');
    assert.strictEqual(result.name, 'Example-vendor');
  });
});

describe('assessDiscoveryCandidate — accepts plausible organisations', () => {
  test('accepts a named regulator', () => {
    const result = assessDiscoveryCandidate({ rawName: 'Solicitors Regulation Authority', domain: 'sra.org.uk' });
    assert.strictEqual(result.accepted, true);
  });

  test('accepts a named professional body / law firm / consultancy shaped name', () => {
    const result = assessDiscoveryCandidate({ rawName: 'Crombie Wilkinson Solicitors', domain: 'crombiewilkinson.co.uk' });
    assert.strictEqual(result.accepted, true);
  });
});

describe('domainToPlausibleName', () => {
  test('derives a capitalised name from a domain', () => {
    assert.strictEqual(domainToPlausibleName('clio.com'), 'Clio');
    assert.strictEqual(domainToPlausibleName('www.knack.com'), 'Knack');
  });
});
