'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { extractFindings } = require('./finding-extraction');

function page(visibleText, headings = []) {
  return { title: 'x', headings, visibleText, footerText: '' };
}

const CTX = { sourceUrl: 'https://complianceoffice.co.uk/', evidenceId: 'ev-1' };

describe('services', () => {
  test('detects an explicit service heading', () => {
    const findings = extractFindings(page('Some intro text.', [{ level: 'h2', text: 'Our Services' }]), CTX);
    assert.ok(findings.some((f) => f.category === 'services' && f.value === 'Our Services'));
  });

  test('detects an explicit "we provide X" statement', () => {
    const findings = extractFindings(page('We provide independent AML audits for regulated firms.'), CTX);
    const f = findings.find((f) => f.category === 'services');
    assert.ok(f);
    assert.match(f.value, /independent AML audits/i);
    assert.strictEqual(f.confidence, 'high');
  });
});

describe('services — section extraction, normalisation and generic-heading suppression (Part 2)', () => {
  test('extracts multiple explicit service-card items under a Services section heading', () => {
    const headings = [
      { level: 'h2', text: 'Services' },
      { level: 'h2', text: 'Independent AML audits & SRA compliance health-checks' },
      { level: 'h2', text: 'Outsourced SRA compliance & COLP support packages' },
      { level: 'h2', text: 'SRA authorisation' },
      { level: 'h1', text: 'Trusted by industry leaders:' },
      { level: 'h2', text: 'Astraea' },
    ];
    const findings = extractFindings(page('', headings), CTX);
    const services = findings.filter((f) => f.category === 'services').map((f) => f.value);
    assert.ok(services.includes('Independent AML audits & SRA compliance health-checks'));
    assert.ok(services.includes('Outsourced SRA compliance & COLP support packages'));
    assert.ok(services.includes('SRA authorisation'));
  });

  test('stops at the next h1 (hard section boundary) — never mistakes client-name headings for services', () => {
    const headings = [
      { level: 'h2', text: 'Services' },
      { level: 'h2', text: 'SRA authorisation' },
      { level: 'h1', text: 'Trusted by industry leaders:' },
      { level: 'h2', text: 'Astraea' },
      { level: 'h2', text: 'Indemnity Legal' },
    ];
    const findings = extractFindings(page('', headings), CTX);
    const services = findings.filter((f) => f.category === 'services').map((f) => f.value);
    assert.ok(!services.includes('Astraea'));
    assert.ok(!services.includes('Indemnity Legal'));
  });

  test('stops at a "Recent articles" section — never mistakes blog-post titles for services', () => {
    const headings = [
      { level: 'h2', text: 'Services' },
      { level: 'h2', text: 'SRA authorisation' },
      { level: 'h2', text: 'Recent articles' },
      { level: 'h2', text: 'Compliance Update July 2026' },
    ];
    const findings = extractFindings(page('', headings), CTX);
    const services = findings.filter((f) => f.category === 'services').map((f) => f.value);
    assert.ok(!services.includes('Compliance Update July 2026'));
  });

  test('suppresses the generic "Services" heading finding once specific service items exist', () => {
    const headings = [
      { level: 'h2', text: 'Services' },
      { level: 'h2', text: 'SRA authorisation' },
    ];
    const findings = extractFindings(page('', headings), CTX);
    const services = findings.filter((f) => f.category === 'services').map((f) => f.value);
    assert.ok(!services.includes('Services'));
    assert.ok(services.includes('SRA authorisation'));
  });

  test('normalises case/hyphenation duplicates into a single finding with the extra excerpt preserved', () => {
    // Two structurally distinct sources (a heading here, an identical "we
    // provide" sentence there) naming the exact same service in different
    // casing/hyphenation — a real cross-source duplicate, not a coincidence
    // of how the sentence happens to be phrased.
    const headings = [{ level: 'h2', text: 'Services' }, { level: 'h2', text: 'SRA Compliance Health Checks' }];
    const findings = extractFindings(page('We provide sra compliance health checks.', headings), CTX);
    const services = findings.filter((f) => f.category === 'services');
    const matching = services.filter((f) => f.value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === 'sra compliance health checks');
    assert.strictEqual(matching.length, 1, 'expected the case/hyphen variants to merge into one finding');
    assert.ok(matching[0].additionalContextExcerpts && matching[0].additionalContextExcerpts.length >= 1);
  });

  test('a third-party generic compliance article does not create target services from unrelated text', () => {
    const findings = extractFindings(page('What are Compliance Services? Compliance services help businesses navigate regulatory requirements. Types of Compliance Services include audits.'), CTX);
    // No "Services" section heading and no "we provide/offer" statement present — nothing should be invented.
    assert.strictEqual(findings.filter((f) => f.category === 'services').length, 0);
  });
});

describe('regulatory expertise', () => {
  for (const phrase of ['SRA compliance audits', 'COLP support', 'COFA support', 'AML compliance', 'FCA compliance advice']) {
    test(`detects explicit phrase: "${phrase}"`, () => {
      const findings = extractFindings(page(`We specialise in ${phrase} for law firms.`), CTX);
      assert.ok(findings.some((f) => f.category === 'regulatoryExpertise'), `expected a regulatoryExpertise finding for "${phrase}"`);
    });
  }

  test('a contextual regulator mention (no explicit expertise phrase) is not promoted', () => {
    const findings = extractFindings(page('The FCA published new guidance this week.'), CTX);
    assert.strictEqual(findings.filter((f) => f.category === 'regulatoryExpertise').length, 0);
  });
});

describe('client sectors', () => {
  test('detects an explicit served-sector statement', () => {
    const findings = extractFindings(page('We work with law firms and solicitors across the UK.'), CTX);
    assert.ok(findings.some((f) => f.category === 'clientsSectors' && f.value === 'law firms'));
  });

  test('a bare sector word with no serving-context verb is not promoted (logo-only-style caution)', () => {
    const findings = extractFindings(page('Law firms are an important part of the UK economy.'), CTX);
    assert.strictEqual(findings.filter((f) => f.category === 'clientsSectors').length, 0);
  });

  test('"we support law firms" is accepted', () => {
    const findings = extractFindings(page('We support law firms with their day-to-day compliance needs.'), CTX);
    assert.ok(findings.some((f) => f.category === 'clientsSectors' && f.value === 'law firms'));
  });

  test('the real Compliance Office false positive: "as solicitors we..." is rejected, not "for" alone', () => {
    const findings = extractFindings(page("For example, as solicitors we have to perform 'conflicts of interest' checks before taking on new work."), CTX);
    assert.strictEqual(findings.filter((f) => f.category === 'clientsSectors').length, 0);
  });

  test('the real Compliance Office correct signal: serving-direction "support to law firms" is accepted', () => {
    const findings = extractFindings(page('Our team of SRA compliance experts offer outsourced risk and compliance support to law firms.'), CTX);
    assert.ok(findings.some((f) => f.category === 'clientsSectors' && f.value === 'law firms'));
  });

  test('employee-biography language is rejected even if it names a sector', () => {
    const findings = extractFindings(page('Jane Smith previously worked for a firm serving law firms and solicitors nationally.'), CTX);
    assert.strictEqual(findings.filter((f) => f.category === 'clientsSectors').length, 0);
  });

  test('a quoted third-party sector statement (inside a testimonial) is rejected', () => {
    const findings = extractFindings(page('Astraea“We work with law firms across London and would highly recommend their support.”'), CTX);
    assert.strictEqual(findings.filter((f) => f.category === 'clientsSectors').length, 0);
  });
});

describe('people', () => {
  test('detects a named person paired with an explicit role', () => {
    const findings = extractFindings(page('Jane Smith is our Director and leads the team.'), CTX);
    assert.ok(findings.some((f) => f.category === 'people' && f.value.name === 'Jane Smith' && f.value.role === 'Director'));
  });

  test('employee-history / biography language does not become a people finding', () => {
    const findings = extractFindings(page('Jane Smith previously worked as a Director at another firm.'), CTX);
    assert.strictEqual(findings.filter((f) => f.category === 'people').length, 0);
  });
});

describe('thought leadership', () => {
  test('detects an authored-article statement', () => {
    const findings = extractFindings(page('Our team wrote an article on AML risk for the trade press.'), CTX);
    assert.ok(findings.some((f) => f.category === 'thoughtLeadership'));
  });

  test('detects a webinar mention', () => {
    const findings = extractFindings(page('Join our upcoming webinar on SRA compliance changes.'), CTX);
    assert.ok(findings.some((f) => f.category === 'thoughtLeadership'));
  });
});

describe('named client testimonials', () => {
  test('detects a named client paired with an explicit first-person quoted testimonial', () => {
    const findings = extractFindings(page('Trusted by industry leaders: Astraea“We have been working with the Compliance Office for a number of years and would highly recommend their retainer support and audit services.”'), CTX);
    const f = findings.find((f) => f.category === 'clientsNamed');
    assert.ok(f);
    assert.strictEqual(f.value, 'Astraea');
    assert.strictEqual(f.confidence, 'high');
  });

  test('detects multiple consecutive testimonials without them bleeding into each other', () => {
    const text = 'Astraea“We have been working with the Compliance Office for a number of years.” Indemnity Legal“I would strongly recommend the team at The Compliance Office.“ APPEAL“We are incredibly grateful for the invaluable support.“';
    const findings = extractFindings(page(text), CTX).filter((f) => f.category === 'clientsNamed');
    assert.deepStrictEqual(findings.map((f) => f.value), ['Astraea', 'Indemnity Legal', 'APPEAL']);
  });

  test('handles a multi-word company name containing an ampersand', () => {
    const findings = extractFindings(page('EJ Winter & Son LLP“The support I have received from Jessica Irwin at Compliance Office has been consistently outstanding.“'), CTX);
    const f = findings.find((f) => f.category === 'clientsNamed');
    assert.ok(f);
    assert.strictEqual(f.value, 'EJ Winter & Son LLP');
  });

  test('does NOT infer a named client from a third-person case-study mention with no first-person quote', () => {
    const findings = extractFindings(page('Meysan“The Compliance Office assisted Meysan in meeting its SRA regulatory obligations in the UK by offering practical guidance.“'), CTX);
    assert.strictEqual(findings.filter((f) => f.category === 'clientsNamed').length, 0);
  });

  test('does not treat a generic UI phrase ("Read More", "Learn More") as a client name', () => {
    const findings = extractFindings(page('Read More“We think you will find this interesting reading and our team recommends it.”'), CTX);
    assert.strictEqual(findings.filter((f) => f.category === 'clientsNamed').length, 0);
  });

  test('does not treat a bare quote with no preceding name-like phrase as a named client', () => {
    const findings = extractFindings(page('“We have been working with the Compliance Office for a number of years.”'), CTX);
    assert.strictEqual(findings.filter((f) => f.category === 'clientsNamed').length, 0);
  });
});

describe('every finding carries the required fields', () => {
  test('category, value, sourceUrl, evidenceId, contextExcerpt, confidence, reason', () => {
    const findings = extractFindings(page('We provide SRA compliance audits for law firms.'), CTX);
    for (const f of findings) {
      assert.ok(f.category);
      assert.ok(f.value !== undefined);
      assert.strictEqual(f.sourceUrl, CTX.sourceUrl);
      assert.strictEqual(f.evidenceId, CTX.evidenceId);
      assert.ok(f.contextExcerpt);
      assert.ok(f.confidence);
      assert.ok(f.reason);
    }
  });
});
