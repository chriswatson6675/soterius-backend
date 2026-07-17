'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createCompaniesHouseLookupTool } = require('./companies-house-lookup');

describe('companies_house_lookup', () => {
  test('an exact name match is reported with high confidence and explicit basis', async () => {
    const searchCompanies = async () => ({ ok: true, results: [{ companyNumber: '12345678', name: 'Compliance Office Ltd' }] });
    const tool = createCompaniesHouseLookupTool({ searchCompanies });
    const result = await tool.execute({ name: 'Compliance Office Ltd', investigationId: 'inv-1' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output.matched, true);
    assert.strictEqual(result.output.matchConfidence, 'high');
    assert.strictEqual(result.output.matchBasis, 'exact_name_match');
  });

  test('a non-exact match returns candidates, never silently picks one', async () => {
    const searchCompanies = async () => ({ ok: true, results: [{ companyNumber: '1', name: 'Compliance Office UK Ltd' }, { companyNumber: '2', name: 'Compliance Office Group Ltd' }] });
    const tool = createCompaniesHouseLookupTool({ searchCompanies });
    const result = await tool.execute({ name: 'Compliance Office', investigationId: 'inv-1' });
    assert.strictEqual(result.output.matched, false);
    assert.strictEqual(result.output.matchConfidence, 'low');
    assert.strictEqual(result.output.candidates.length, 2);
  });

  test('distinguishes no result from a tool failure', async () => {
    const noResult = createCompaniesHouseLookupTool({ searchCompanies: async () => ({ ok: true, results: [] }) });
    const noResultOutcome = await noResult.execute({ name: 'Nonexistent Firm Xyz', investigationId: 'inv-1' });
    assert.strictEqual(noResultOutcome.success, true);
    assert.strictEqual(noResultOutcome.output.matched, false);
    assert.strictEqual(noResultOutcome.output.matchBasis, 'no_result');

    const failing = createCompaniesHouseLookupTool({ searchCompanies: async () => ({ ok: false, error: 'API unavailable' }) });
    const failureOutcome = await failing.execute({ name: 'X', investigationId: 'inv-1' });
    assert.strictEqual(failureOutcome.success, false);
  });

  test('looks up directly by company number when supplied', async () => {
    const getCompanyProfile = async () => ({ ok: true, company: { companyNumber: '12345678', name: 'Compliance Office Ltd' } });
    const tool = createCompaniesHouseLookupTool({ getCompanyProfile });
    const result = await tool.execute({ companyNumber: '12345678', investigationId: 'inv-1' });
    assert.strictEqual(result.output.matchBasis, 'company_number_lookup');
    assert.strictEqual(result.output.matchConfidence, 'high');
  });

  test('rejects input with neither name nor companyNumber', async () => {
    const tool = createCompaniesHouseLookupTool({});
    const result = await tool.execute({ investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'invalid_input');
  });
});
