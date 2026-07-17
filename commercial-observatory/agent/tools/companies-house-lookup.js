'use strict';

// companies_house_lookup — thin wrapper around the ALREADY-EXISTING single-
// lookup adapter (organisation/adapters/companiesHouse.js), which is
// itself the product's own "look one firm up" path (rate-limited,
// never-throwing) — reused verbatim, not reimplemented.
//
// Never infers identity silently: an exact (case-insensitive) name match
// is reported with high confidence and basis 'exact_name_match'; anything
// else is returned as a candidate list with confidence 'low' and basis
// 'name_search_candidate' — the caller (planner/orchestrator) decides
// whether a candidate is good enough to cite, never this tool.

const { searchCompanies: defaultSearchCompanies, getCompanyProfile: defaultGetCompanyProfile } = require('../../../organisation/adapters/companiesHouse');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['investigationId'],
  properties: { name: { type: 'string', optional: true }, companyNumber: { type: 'string', optional: true }, investigationId: { type: 'string' } },
};

function validate(input) {
  const result = validateInput(input, INPUT_SCHEMA);
  if (!input?.name && !input?.companyNumber) result.errors.push('Either name or companyNumber is required.');
  result.valid = result.errors.length === 0;
  return result;
}

function createCompaniesHouseLookupTool(deps = {}) {
  const searchCompanies = deps.searchCompanies || defaultSearchCompanies;
  const getCompanyProfile = deps.getCompanyProfile || defaultGetCompanyProfile;

  async function rawExecute(input) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('companies_house_lookup', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    if (input.companyNumber) {
      const profileResult = await getCompanyProfile(input.companyNumber);
      if (!profileResult.ok) {
        return failureResult('companies_house_lookup', { errorType: 'lookup_failed', error: profileResult.error, retryable: false });
      }
      return successResult('companies_house_lookup', {
        matched: true, matchConfidence: 'high', matchBasis: 'company_number_lookup',
        company: profileResult.company,
      }, { provenance: { source: 'companies-house-adapter', companyNumber: input.companyNumber } });
    }

    const searchResult = await searchCompanies(input.name);
    if (!searchResult.ok) {
      return failureResult('companies_house_lookup', { errorType: 'lookup_failed', error: searchResult.error, retryable: false });
    }

    const results = searchResult.results || [];
    if (results.length === 0) {
      return successResult('companies_house_lookup', { matched: false, matchConfidence: null, matchBasis: 'no_result', candidates: [] });
    }

    const exact = results.find((r) => r.name.toLowerCase() === input.name.toLowerCase());
    if (exact) {
      return successResult('companies_house_lookup', {
        matched: true, matchConfidence: 'high', matchBasis: 'exact_name_match', company: exact, candidates: results,
      }, { provenance: { source: 'companies-house-adapter', query: input.name } });
    }

    return successResult('companies_house_lookup', {
      matched: false, matchConfidence: 'low', matchBasis: 'name_search_candidate', candidates: results,
    }, { provenance: { source: 'companies-house-adapter', query: input.name } });
  }

  return {
    name: 'companies_house_lookup',
    description: 'Looks up a company by name or number via the Companies House register. Never silently infers identity — reports match confidence/basis explicitly.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 15000,
    maxRetries: 0,
    execute: rawExecute,
  };
}

module.exports = { createCompaniesHouseLookupTool };
