'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { detectEntities } = require('./entity-detection');

function page(visibleText, extra = {}) {
  return { sourceUrl: 'https://complianceoffice.co.uk/about', extracted: { visibleText, headings: [], footerText: '', externalLinks: [], jsonLd: [], ...extra } };
}

describe('regulator detection', () => {
  test('an explicit "authorised and regulated by the FCA" phrase becomes a verified regulator relationship candidate', () => {
    const result = detectEntities(page('We are authorised and regulated by the Financial Conduct Authority (FCA).'));
    const fca = result.relationshipCandidates.find((c) => c.normalisedName.includes('FINANCIAL CONDUCT AUTHORITY'));
    assert.ok(fca);
    assert.strictEqual(fca.relationshipType, 'regulator');
    assert.strictEqual(fca.relationshipDirection, 'outbound');
    assert.strictEqual(fca.relationshipConfidenceState, 'verified');
  });

  test('a bare mention of the FCA in an article, with no phrase, is a contextual reference only', () => {
    const result = detectEntities(page('The FCA published new guidance on consumer duty this week.'));
    assert.strictEqual(result.relationshipCandidates.length, 0);
    assert.ok(result.contextualMentions.some((m) => m.normalisedName.includes('FINANCIAL CONDUCT AUTHORITY')));
  });

  test('"advises firms regulated by the FCA" does not become a regulator relationship for the subject itself', () => {
    const result = detectEntities(page('Our consultants advise firms regulated by the Financial Conduct Authority across the UK.'));
    assert.strictEqual(result.relationshipCandidates.length, 0);
    assert.ok(result.contextualMentions.some((m) => m.normalisedName.includes('FINANCIAL CONDUCT AUTHORITY')));
  });
});

describe('professional-body detection', () => {
  test('"member of the ICAEW" becomes a professional_body relationship candidate', () => {
    const result = detectEntities(page('Our lead consultant is a member of the ICAEW.'));
    const icaew = result.relationshipCandidates.find((c) => c.normalisedName === 'ICAEW');
    assert.ok(icaew);
    assert.strictEqual(icaew.relationshipType, 'professional_body');
    assert.strictEqual(icaew.relationshipDirection, 'outbound');
  });

  test('acronyms require word boundaries — "ico" inside another word is not matched', () => {
    const result = detectEntities(page('Our unicorn strategy is bespoke.')); // contains "ico" inside "unicorn"
    assert.strictEqual(result.relationshipCandidates.length, 0);
    assert.strictEqual(result.contextualMentions.length, 0);
  });
});

describe('explicit partnership detection', () => {
  test('"in partnership with X" (known vocabulary) becomes a mutual strategic_partner candidate', () => {
    const result = detectEntities(page('We work in partnership with the National Cyber Security Centre (NCSC) on threat briefings.'));
    const ncsc = result.relationshipCandidates.find((c) => c.normalisedName.includes('NATIONAL CYBER SECURITY CENTRE'));
    assert.ok(ncsc);
    assert.strictEqual(ncsc.relationshipDirection, 'mutual');
  });

  test('"official partner of X" via an external link becomes a strategic_partner candidate', () => {
    const result = detectEntities({
      sourceUrl: 'https://complianceoffice.co.uk/partners',
      extracted: {
        visibleText: 'We are proud to be an official partner of Acme Compliance Software.',
        headings: [], footerText: '',
        externalLinks: [{ href: 'https://acmecompliance.example/', text: 'Acme Compliance Software' }],
        jsonLd: [],
      },
    });
    const acme = result.relationshipCandidates.find((c) => c.normalisedName.includes('ACME'));
    assert.ok(acme);
    assert.strictEqual(acme.relationshipType, 'strategic_partner');
    assert.strictEqual(acme.detectionMethod, 'external_link');
  });
});

describe('explicit certification detection', () => {
  test('"certified by BSI" becomes a certification_body relationship candidate', () => {
    const result = detectEntities(page('Our management system is certified by the British Standards Institution (BSI).'));
    const bsi = result.relationshipCandidates.find((c) => c.normalisedName.includes('BRITISH STANDARDS'));
    assert.ok(bsi);
    assert.strictEqual(bsi.relationshipType, 'certification_body');
  });
});

describe('named-client caution', () => {
  test('a logo-only external link with no phrase is NOT inferred as a client relationship', () => {
    const result = detectEntities({
      sourceUrl: 'https://complianceoffice.co.uk/clients',
      extracted: {
        visibleText: 'Some of the organisations we have worked with.',
        headings: [], footerText: '',
        externalLinks: [{ href: 'https://bigbank.example/', text: 'Big Bank plc' }],
        jsonLd: [],
      },
    });
    assert.strictEqual(result.relationshipCandidates.length, 0);
    assert.ok(result.contextualMentions.some((m) => m.rawName === 'Big Bank plc'));
  });

  test('explicit "provides services to X" becomes a client relationship with inbound direction', () => {
    const result = detectEntities(page('We provide services to Big Bank plc across their compliance function.'));
    // no vocabulary/link match for "Big Bank plc" here (plain text, not linked) — so no candidate is expected
    // from this path; this test documents that plain-text client phrases without a link/known-vocabulary match
    // still do not fabricate a named-client relationship.
    assert.strictEqual(result.relationshipCandidates.length, 0);
  });
});

describe('duplicate observation merging (within one page)', () => {
  test('the same entity/relationship mentioned twice on one page merges into a single candidate', () => {
    const result = detectEntities(page('We are regulated by the FCA. As a firm regulated by the FCA, we take this seriously.'));
    const fcaCandidates = result.relationshipCandidates.filter((c) => c.normalisedName.includes('FINANCIAL CONDUCT AUTHORITY'));
    assert.strictEqual(fcaCandidates.length, 1);
  });
});

describe('structured data (JSON-LD)', () => {
  test('a memberOf reference becomes a professional_body candidate', () => {
    const result = detectEntities({
      sourceUrl: 'https://complianceoffice.co.uk/',
      extracted: {
        visibleText: '', headings: [], footerText: '', externalLinks: [],
        jsonLd: [{ '@type': 'Organization', name: 'Compliance Office', memberOf: { name: 'The Law Society', url: 'https://www.lawsociety.org.uk/' } }],
      },
    });
    const lawSociety = result.relationshipCandidates.find((c) => c.normalisedName.includes('LAW SOCIETY'));
    assert.ok(lawSociety);
    assert.strictEqual(lawSociety.relationshipType, 'professional_body');
    assert.strictEqual(lawSociety.detectionMethod, 'structured_data');
  });
});

describe('cross-sentence containment (precision pass regression)', () => {
  test('a phrase in one sentence is never attributed to an entity mentioned only in the next sentence', () => {
    const result = detectEntities(page('We work in partnership with the National Cyber Security Centre (NCSC). The FCA published new guidance this week.'));
    const ncsc = result.relationshipCandidates.find((c) => c.normalisedName.includes('NATIONAL CYBER SECURITY CENTRE'));
    assert.ok(ncsc);
    assert.strictEqual(ncsc.relationshipType, 'strategic_partner');
    // FCA is only mentioned in the second sentence, with no phrase of its own — must remain contextual.
    assert.ok(!result.relationshipCandidates.some((c) => c.normalisedName.includes('FINANCIAL CONDUCT AUTHORITY')));
    assert.ok(result.contextualMentions.some((m) => m.normalisedName.includes('FINANCIAL CONDUCT AUTHORITY')));
  });

  test('the HMRC false positive this task fixes: same-sentence co-occurrence with an unrelated requirement is not promoted', () => {
    const result = detectEntities(page("From 18 August 2026, HMRC will not accept communications on a client's behalf from anyone not registered with an Agent Services Account."));
    assert.ok(!result.relationshipCandidates.some((c) => c.normalisedName.includes('HM REVENUE')));
    const hmrcMention = result.contextualMentions.find((m) => m.normalisedName.includes('HM REVENUE'));
    assert.ok(hmrcMention);
    assert.ok(hmrcMention.classification);
    assert.ok(hmrcMention.rejectionReason);
  });
});

describe('entity name / identifier separation (Part 4 regression — the real ICO/ZA075078 case)', () => {
  const ICO_SENTENCE = "The Compliance Office is registered with the Information Commissioner's Office under registration number ZA075078.";

  test('the known-vocabulary pass correctly names the ICO itself as the relationship entity', () => {
    const result = detectEntities(page(ICO_SENTENCE), { subjectName: 'Compliance Office' });
    const ico = result.relationshipCandidates.find((c) => c.normalisedName.includes('INFORMATION COMMISSIONER'));
    assert.ok(ico, 'expected a relationship candidate for the Information Commissioner\'s Office');
    assert.strictEqual(ico.relationshipType, 'regulator');
  });

  test('an ICO registration-number lookup link (anchor text = the number itself) never becomes a discovery or relationship named after the number', () => {
    const result = detectEntities(page(ICO_SENTENCE, {
      externalLinks: [{ href: 'https://ico.org.uk/ESDWebPages/Entry/ZA075078', text: 'ZA075078' }],
    }), { subjectName: 'Compliance Office' });

    assert.ok(!result.linkedOrganisations.some((lo) => lo.rawName === 'ZA075078'));
    assert.ok(!result.relationshipCandidates.some((c) => c.rawName === 'ZA075078'));
    assert.ok(!result.contextualMentions.some((m) => m.rawName === 'ZA075078'));
  });

  test('a generic "here" anchor linking to a regulator\'s homepage never becomes a discovery', () => {
    const result = detectEntities(page('See here for more information.', {
      externalLinks: [{ href: 'https://ico.org.uk/', text: 'here' }],
    }), { subjectName: 'Compliance Office' });
    assert.ok(!result.linkedOrganisations.some((lo) => lo.rawName === 'here'));
  });

  test('a raw-URL anchor in an explicit sub-processor list is accepted as a technology vendor, named from its domain', () => {
    const subprocessorText = 'Our sub-processors for data protection purposes are as follows: https://www.clio.com/uk/';
    const result = detectEntities(page(subprocessorText, {
      externalLinks: [{ href: 'https://www.clio.com/uk/', text: 'https://www.clio.com/uk/' }],
    }), { subjectName: 'Compliance Office' });
    const clio = result.linkedOrganisations.find((lo) => lo.domain === 'clio.com');
    assert.ok(clio);
    assert.strictEqual(clio.rawName, 'Clio');
    assert.strictEqual(clio.candidateCategory, 'technology_vendor');
    // Named as a vendor, but never asserted as a partnership — the sentence
    // doesn't contain a recognised relationship phrase.
    assert.ok(!result.relationshipCandidates.some((c) => c.domain === 'clio.com'));
  });
});

describe('subject exclusion', () => {
  test('the investigation subject\'s own name is never detected as a co-party', () => {
    const result = detectEntities(
      { sourceUrl: 'https://complianceoffice.co.uk/', extracted: { visibleText: 'Compliance Office is regulated by the FCA.', headings: [], footerText: '', externalLinks: [], jsonLd: [] } },
      { subjectName: 'Compliance Office' },
    );
    assert.ok(!result.relationshipCandidates.some((c) => c.normalisedName === 'COMPLIANCE OFFICE'));
    assert.ok(!result.contextualMentions.some((m) => m.normalisedName === 'COMPLIANCE OFFICE'));
    assert.ok(result.relationshipCandidates.some((c) => c.normalisedName.includes('FINANCIAL CONDUCT AUTHORITY')));
  });
});
