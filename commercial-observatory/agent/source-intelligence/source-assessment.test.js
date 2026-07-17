'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { assessSource, classifySource, classifyJurisdiction } = require('./source-assessment');

const TARGET = { targetName: 'Compliance Office', targetDomain: 'complianceoffice.co.uk' };

describe('classifySource', () => {
  test('classifies the target\'s own domain as first_party', () => {
    assert.strictEqual(classifySource('complianceoffice.co.uk', 'complianceoffice.co.uk'), 'first_party');
  });
  test('classifies a known register/regulator domain as regulator', () => {
    assert.strictEqual(classifySource('sra.org.uk', 'complianceoffice.co.uk'), 'regulator');
    assert.strictEqual(classifySource('gov.uk', null), 'regulator');
  });
  test('classifies a known professional body domain', () => {
    assert.strictEqual(classifySource('lawsociety.org.uk', null), 'professional_body');
  });
  test('classifies a known news publication domain', () => {
    assert.strictEqual(classifySource('ft.com', null), 'news_publication');
  });
  test('classifies a known commercial directory/aggregator domain', () => {
    assert.strictEqual(classifySource('dnb.com', null), 'commercial_directory');
    assert.strictEqual(classifySource('zoominfo.com', null), 'commercial_directory');
  });
  test('classifies a known generic reference domain', () => {
    assert.strictEqual(classifySource('bls.gov', null), 'generic_reference');
    assert.strictEqual(classifySource('onetonline.org', null), 'generic_reference');
  });
  test('classifies a social platform', () => {
    assert.strictEqual(classifySource('linkedin.com', null), 'social_platform');
  });
  test('classifies an unrecognised commercial domain as unrelated_organisation', () => {
    assert.strictEqual(classifySource('captaincompliance.com', 'complianceoffice.co.uk'), 'unrelated_organisation');
  });
});

describe('classifyJurisdiction', () => {
  test('recognises a .uk domain as uk', () => {
    assert.strictEqual(classifyJurisdiction('complianceoffice.co.uk'), 'uk');
    assert.strictEqual(classifyJurisdiction('sra.org.uk'), 'uk');
  });
  test('recognises a known non-UK suffix as non_uk', () => {
    assert.strictEqual(classifyJurisdiction('bls.gov'), 'non_uk');
  });
  test('treats an ambiguous .com domain as unknown', () => {
    assert.strictEqual(classifyJurisdiction('example.com'), 'unknown');
  });
});

describe('assessSource — target mode (the real Compliance Office regression cases)', () => {
  test('rejects a US occupational-handbook page that shares vocabulary with the target but is about the job title, not the company', () => {
    const a = assessSource({
      url: 'https://www.bls.gov/ooh/business-and-financial/compliance-officers.htm',
      title: 'Compliance Officers : Occupational Outlook Handbook: : U.S. Bureau of Labor Statistics',
      snippet: 'Compliance officers ensure that a company complies with outside regulations.',
      ...TARGET,
    });
    assert.strictEqual(a.classification, 'generic_reference');
    assert.strictEqual(a.jurisdiction, 'non_uk');
    assert.strictEqual(a.recommendation, 'skip');
  });

  test('rejects an unrelated vendor whose name happens to contain "Compliance"', () => {
    const a = assessSource({
      url: 'https://captaincompliance.com/education/compliance-services/',
      title: 'What are Compliance Services? (Different Types) - Captain Compliance',
      snippet: 'Compliance services help businesses navigate regulatory requirements.',
      ...TARGET,
    });
    assert.strictEqual(a.classification, 'unrelated_organisation');
    assert.strictEqual(a.recommendation, 'skip');
    assert.strictEqual(a.organisationRelevance, 0);
  });

  test('accepts the Companies House register page for the exact target company', () => {
    const a = assessSource({
      url: 'https://find-and-update.company-information.service.gov.uk/company/09133668',
      title: 'THE COMPLIANCE OFFICE LTD overview - Find and update company information - GOV.UK',
      snippet: 'Compliance Office Ltd',
      ...TARGET,
    });
    assert.strictEqual(a.classification, 'regulator');
    assert.strictEqual(a.recommendation, 'fetch');
    assert.ok(a.compositeScore >= 80);
  });

  test('accepts a first-party subpage of the target\'s own domain', () => {
    const a = assessSource({
      url: 'https://complianceoffice.co.uk/privacy-and-cookies-policy/',
      title: 'Privacy and cookies policy - Compliance Office',
      snippet: 'Compliance Office',
      ...TARGET,
    });
    assert.strictEqual(a.classification, 'first_party');
    assert.strictEqual(a.partyType, 'first_party');
    assert.strictEqual(a.recommendation, 'fetch');
  });

  test('never falsely matches a plural/substring variant of the target name (e.g. "officers" containing "office")', () => {
    const a = assessSource({ url: 'https://example.com/x', title: 'Compliance Officers Handbook', snippet: 'about compliance officers generally', ...TARGET });
    assert.strictEqual(a.organisationRelevance, 0);
  });
});

describe('assessSource — standalone (co-party) mode, no target supplied', () => {
  test('a known regulator is recommended for fetch on its own merits', () => {
    const a = assessSource({ url: 'https://sra.org.uk/' });
    assert.strictEqual(a.classification, 'regulator');
    assert.strictEqual(a.recommendation, 'fetch');
  });

  test('a generic-reference job-classification site is not worth following as a co-party', () => {
    const a = assessSource({ url: 'https://onetonline.org/' });
    assert.strictEqual(a.classification, 'generic_reference');
    assert.strictEqual(a.recommendation, 'skip');
  });

  test('a social platform is always skipped regardless of mode', () => {
    const a = assessSource({ url: 'https://www.linkedin.com/company/some-firm' });
    assert.strictEqual(a.classification, 'social_platform');
    assert.strictEqual(a.recommendation, 'skip');
  });

  test('organisationRelevance and commercialRelevance are null (not applicable), not zero, when no target is supplied', () => {
    const a = assessSource({ url: 'https://example-firm.co.uk/' });
    assert.strictEqual(a.organisationRelevance, null);
    assert.strictEqual(a.commercialRelevance, null);
  });
});

describe('assessSource — dimensions and shape', () => {
  test('reports every required dimension', () => {
    const a = assessSource({ url: 'https://sra.org.uk/', ...TARGET });
    for (const field of ['classification', 'partyType', 'jurisdiction', 'authority', 'regulatoryRelevance', 'evidenceLikelihood', 'compositeScore', 'recommendation', 'reasons']) {
      assert.ok(field in a, `missing field: ${field}`);
    }
  });

  test('an unparseable URL is a clean, non-throwing skip', () => {
    const a = assessSource({ url: 'not a url at all' });
    assert.strictEqual(a.recommendation, 'skip');
    assert.strictEqual(a.domain, null);
  });

  test('composite score is always within 0-100', () => {
    for (const url of ['https://sra.org.uk/', 'https://linkedin.com/x', 'https://random-firm.example/']) {
      const a = assessSource({ url, ...TARGET });
      assert.ok(a.compositeScore >= 0 && a.compositeScore <= 100);
    }
  });

  test('reasons is a non-empty, human-readable audit trail', () => {
    const a = assessSource({ url: 'https://captaincompliance.com/x', ...TARGET });
    assert.ok(Array.isArray(a.reasons) && a.reasons.length > 0);
  });
});
