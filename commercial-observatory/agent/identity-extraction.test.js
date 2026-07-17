'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { extractCompaniesHouseIdentity, extractLegalNameCorroboration, isCompaniesHouseOverviewPage } = require('./identity-extraction');

function chPage(overrides = {}) {
  return {
    title: 'THE COMPLIANCE OFFICE LTD overview - Find and update company information - GOV.UK',
    headings: [{ level: 'h1', text: 'THE COMPLIANCE OFFICE LTD' }],
    visibleText: 'THE COMPLIANCE OFFICE LTD Company number 09133668 Follow this company Registered office address 20 Grosvenor Place, London, England, SW1X 7HN Company status Active Company type Private limited Company Incorporated on 16 July 2014',
    footerText: '',
    ...overrides,
  };
}

const CH_URL = 'https://find-and-update.company-information.service.gov.uk/company/09133668';

describe('isCompaniesHouseOverviewPage', () => {
  test('recognises a genuine company overview URL', () => {
    assert.strictEqual(isCompaniesHouseOverviewPage(CH_URL), true);
  });
  test('rejects an unrelated gov.uk page', () => {
    assert.strictEqual(isCompaniesHouseOverviewPage('https://www.gov.uk/'), false);
  });
});

describe('extractCompaniesHouseIdentity — exact match', () => {
  test('extracts legal name and company number for an exact (normalised) name match', () => {
    const findings = extractCompaniesHouseIdentity(chPage(), { sourceUrl: CH_URL, evidenceId: 'ev-1', targetName: 'Compliance Office' });
    const legalName = findings.find((f) => f.field === 'legalName');
    const companyNumber = findings.find((f) => f.field === 'companyNumber');
    assert.strictEqual(legalName.value, 'THE COMPLIANCE OFFICE LTD');
    assert.strictEqual(companyNumber.value, '09133668');
  });

  test('extracts registered-office address, status, type and incorporation date where explicitly available', () => {
    const findings = extractCompaniesHouseIdentity(chPage(), { sourceUrl: CH_URL, evidenceId: 'ev-1', targetName: 'Compliance Office' });
    assert.strictEqual(findings.find((f) => f.field === 'companyStatus').value, 'Active');
    assert.strictEqual(findings.find((f) => f.field === 'companyType').value, 'Private limited Company');
    assert.strictEqual(findings.find((f) => f.field === 'incorporatedOn').value, '16 July 2014');
    assert.strictEqual(findings.find((f) => f.field === 'registeredOfficeAddress').value, '20 Grosvenor Place, London, England, SW1X 7HN');
  });

  test('the company number is never used as the organisation name', () => {
    const findings = extractCompaniesHouseIdentity(chPage(), { sourceUrl: CH_URL, evidenceId: 'ev-1', targetName: 'Compliance Office' });
    const legalName = findings.find((f) => f.field === 'legalName');
    assert.notStrictEqual(legalName.value, '09133668');
    assert.match(legalName.value, /COMPLIANCE OFFICE/i);
  });

  test('medium confidence without first-party corroboration', () => {
    const findings = extractCompaniesHouseIdentity(chPage(), { sourceUrl: CH_URL, evidenceId: 'ev-1', targetName: 'Compliance Office' });
    assert.strictEqual(findings[0].confidence, 'medium');
    assert.strictEqual(findings[0].matchBasis, 'target_name_normalised_match');
  });

  test('high confidence when a first-party legal-name corroboration finding is present and matches', () => {
    const corroboration = { field: 'legalNameCorroboration', value: 'Compliance Office Ltd', evidenceId: 'ev-corro' };
    const findings = extractCompaniesHouseIdentity(chPage(), { sourceUrl: CH_URL, evidenceId: 'ev-1', targetName: 'Compliance Office', priorIdentityFindings: [corroboration] });
    assert.strictEqual(findings[0].confidence, 'high');
    assert.strictEqual(findings[0].matchBasis, 'first_party_corroborated');
    assert.deepStrictEqual(findings[0].corroboratingEvidenceIds, ['ev-corro']);
  });

  test('every finding records source URL and evidence id', () => {
    const findings = extractCompaniesHouseIdentity(chPage(), { sourceUrl: CH_URL, evidenceId: 'ev-1', targetName: 'Compliance Office' });
    for (const f of findings) {
      assert.strictEqual(f.sourceUrl, CH_URL);
      assert.strictEqual(f.evidenceId, 'ev-1');
    }
  });
});

describe('extractCompaniesHouseIdentity — rejects a weak/generic match', () => {
  test('rejects entirely when the register name does not match the target at all', () => {
    const findings = extractCompaniesHouseIdentity(chPage(), { sourceUrl: CH_URL, evidenceId: 'ev-1', targetName: 'Totally Different Firm' });
    assert.strictEqual(findings.length, 0);
  });

  test('rejects a merely similar/generic-word overlap, not just a total mismatch', () => {
    // "Office" alone overlapping is not enough — the whole normalised name must match.
    const findings = extractCompaniesHouseIdentity(chPage(), { sourceUrl: CH_URL, evidenceId: 'ev-1', targetName: 'Office Supplies Direct' });
    assert.strictEqual(findings.length, 0);
  });

  test('returns nothing for a page that is not a genuine Companies House overview page', () => {
    const findings = extractCompaniesHouseIdentity(chPage(), { sourceUrl: 'https://www.gov.uk/some-guidance', evidenceId: 'ev-1', targetName: 'Compliance Office' });
    assert.strictEqual(findings.length, 0);
  });
});

describe('extractLegalNameCorroboration', () => {
  test('detects a footer copyright legal-name statement', () => {
    const page = { visibleText: 'Terms and conditions of sale Privacy and cookies policy © Compliance Office Ltd', footerText: '' };
    const finding = extractLegalNameCorroboration(page, { sourceUrl: 'https://complianceoffice.co.uk/privacy-and-cookies-policy/', evidenceId: 'ev-2' });
    assert.ok(finding);
    assert.strictEqual(finding.value, 'Compliance Office Ltd');
    assert.strictEqual(finding.field, 'legalNameCorroboration');
  });

  test('returns null when no copyright legal-name statement is present', () => {
    const page = { visibleText: 'Welcome to our website. We do great things.', footerText: '' };
    assert.strictEqual(extractLegalNameCorroboration(page, { sourceUrl: 'https://example.com/', evidenceId: 'ev-2' }), null);
  });
});
