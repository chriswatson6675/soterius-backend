'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildHtml, generateTrustProfilePdf } = require('./trust-profile-pdf');

function instance(overrides = {}) {
  return {
    organisationId: 'ORG-1',
    organisationDomains: ['example.com'],
    generatedAt: '2026-07-13T00:00:00.000Z',
    trigger: 'on-demand',
    provenanceVector: {},
    provenanceManifest: {},
    trustScore: { value: 750, band: 'Good', earned: 700, attainable: 900, completeness: 0.9, coreComplete: false, observedSignalCount: 1 },
    componentBreakdown: [
      { id: 'spf', category: 'A', weight: 100, observed: true, earned: 90 },
      { id: 'dmarc', category: 'A', observed: false },
    ],
    categoryScores: { A: { earned: 700, attainable: 900 } },
    ...overrides,
  };
}

describe('buildHtml — never recomputes a score, only presents what it is given', () => {
  test('renders the trustScore value/band verbatim', () => {
    const html = buildHtml({ instance: instance(), organisationName: 'Test Solicitors LLP', consultancyName: 'Acme Compliance' });
    assert.match(html, /750/);
    assert.match(html, /Good/);
    assert.match(html, /Test Solicitors LLP/);
    assert.match(html, /Acme Compliance/);
    assert.match(html, /ORG-1/);
  });

  test('renders each componentBreakdown entry, observed and not-observed alike', () => {
    const html = buildHtml({ instance: instance(), organisationName: 'Test Solicitors LLP' });
    assert.match(html, /SPF/i);
    assert.match(html, /DMARC/i);
    assert.match(html, /Not observed/);
  });

  test('renders INSUFFICIENT_OBSERVATION honestly, without fabricating a score', () => {
    const html = buildHtml({
      instance: instance({ trustScore: { value: 'INSUFFICIENT_OBSERVATION', earned: 0, attainable: 0, completeness: 0, coreComplete: false, observedSignalCount: 0 }, componentBreakdown: [] }),
      organisationName: 'New Firm LLP',
    });
    assert.match(html, /Insufficient Observation/);
    assert.doesNotMatch(html, /undefined/);
  });

  test('defaults to a generic label when no consultancy name is supplied', () => {
    const html = buildHtml({ instance: instance(), organisationName: 'Test Solicitors LLP' });
    assert.match(html, /Compliance Advisor/);
  });

  test('escapes organisation/consultancy names to prevent HTML injection', () => {
    const html = buildHtml({ instance: instance(), organisationName: '<script>alert(1)</script>', consultancyName: '<b>x</b>' });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('generateTrustProfilePdf', () => {
  test('produces a non-empty Buffer', async () => {
    const pdf = await generateTrustProfilePdf({ instance: instance(), organisationName: 'Test Solicitors LLP', consultancyName: 'Acme Compliance' });
    assert.ok(Buffer.isBuffer(pdf));
    assert.ok(pdf.length > 0);
    // %PDF is the standard PDF file signature.
    assert.strictEqual(pdf.subarray(0, 4).toString('ascii'), '%PDF');
  });
});
