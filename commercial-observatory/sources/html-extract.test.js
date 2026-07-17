'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { extractHtml } = require('./html-extract');

const SAMPLE_HTML = `
<html>
<head>
  <title>Compliance Office | Home</title>
  <link rel="canonical" href="https://complianceoffice.co.uk/" />
  <meta name="description" content="  Compliance consultancy for   regulated firms.  " />
  <script>console.log('should be removed')</script>
  <style>.x { display:none }</style>
  <script type="application/ld+json">
    { "@context": "https://schema.org", "@type": "Organization", "name": "Compliance Office", "sameAs": ["https://www.linkedin.com/company/compliance-office"] }
  </script>
</head>
<body>
  <header><nav><a href="/about">About</a><a href="/about">About</a><a href="/services">Services</a></nav></header>
  <h1>Compliance Office</h1>
  <h2>Our Services</h2>
  <p>We are regulated by the <a href="https://www.fca.org.uk/">Financial Conduct Authority</a>.</p>
  <div hidden>secret boilerplate</div>
  <footer>© 2026 Compliance Office. Member of the <a href="https://www.icaew.com/">ICAEW</a>.</footer>
</body>
</html>
`;

describe('extractHtml', () => {
  test('extracts the title, canonical URL and meta description', () => {
    const result = extractHtml(SAMPLE_HTML, 'https://complianceoffice.co.uk/');
    assert.strictEqual(result.title, 'Compliance Office | Home');
    assert.strictEqual(result.canonicalUrl, 'https://complianceoffice.co.uk/');
    assert.strictEqual(result.metaDescription, 'Compliance consultancy for regulated firms.');
  });

  test('extracts headings in document order', () => {
    const result = extractHtml(SAMPLE_HTML, 'https://complianceoffice.co.uk/');
    assert.deepStrictEqual(result.headings.map((h) => h.text), ['Compliance Office', 'Our Services']);
  });

  test('classifies internal vs external links by hostname, resolving relative hrefs', () => {
    const result = extractHtml(SAMPLE_HTML, 'https://complianceoffice.co.uk/');
    assert.ok(result.internalLinks.some((l) => l.href === 'https://complianceoffice.co.uk/services'));
    assert.ok(result.externalLinks.some((l) => l.href === 'https://www.fca.org.uk/'));
    assert.ok(result.externalLinks.some((l) => l.href === 'https://www.icaew.com/'));
  });

  test('deduplicates identical repeated links', () => {
    const result = extractHtml(SAMPLE_HTML, 'https://complianceoffice.co.uk/');
    const aboutLinks = result.internalLinks.filter((l) => l.href.endsWith('/about'));
    assert.strictEqual(aboutLinks.length, 1);
  });

  test('removes scripts and styles from visible text', () => {
    const result = extractHtml(SAMPLE_HTML, 'https://complianceoffice.co.uk/');
    assert.ok(!result.visibleText.includes('console.log'));
    assert.ok(!result.visibleText.includes('display:none'));
  });

  test('removes hidden boilerplate elements', () => {
    const result = extractHtml(SAMPLE_HTML, 'https://complianceoffice.co.uk/');
    assert.ok(!result.visibleText.includes('secret boilerplate'));
  });

  test('collapses duplicate whitespace', () => {
    const result = extractHtml(SAMPLE_HTML, 'https://complianceoffice.co.uk/');
    assert.ok(!result.metaDescription.includes('  '));
  });

  test('extracts JSON-LD organisation references', () => {
    const result = extractHtml(SAMPLE_HTML, 'https://complianceoffice.co.uk/');
    assert.strictEqual(result.jsonLd.length, 1);
    assert.strictEqual(result.jsonLd[0]['@type'], 'Organization');
  });

  test('ignores malformed JSON-LD rather than failing extraction', () => {
    const html = SAMPLE_HTML.replace(/"name": "Compliance Office",/, '"name": "Compliance Office",,,broken');
    const result = extractHtml(html, 'https://complianceoffice.co.uk/');
    assert.strictEqual(result.jsonLd.length, 0);
    assert.ok(result.title);
  });

  test('extracts footer text and deduplicated navigation labels', () => {
    const result = extractHtml(SAMPLE_HTML, 'https://complianceoffice.co.uk/');
    assert.ok(result.footerText.includes('Member of the ICAEW'));
    assert.deepStrictEqual(result.navigationLabels, ['About', 'Services']);
  });

  test('handles empty/malformed HTML without throwing', () => {
    const result = extractHtml('<not really html', 'https://example.com/');
    assert.strictEqual(typeof result.visibleText, 'string');
  });
});
