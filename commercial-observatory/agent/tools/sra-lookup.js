'use strict';

// sra_lookup — thin wrapper around the ALREADY-EXISTING SRA adapter
// (organisation/adapters/sra.js), which serves fast in-process lookups
// against the most-recently-sealed local SRA snapshot (the real SRA Firm
// Data feed has no live single-firm endpoint — see that module's own
// header comment). No API key involved; read-only.

const { searchByName: defaultSearchByName, findBySraNumber: defaultFindBySraNumber } = require('../../../organisation/adapters/sra');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['investigationId'],
  properties: { name: { type: 'string', optional: true }, sraNumber: { type: 'string', optional: true }, investigationId: { type: 'string' } },
};

function validate(input) {
  const result = validateInput(input, INPUT_SCHEMA);
  if (!input?.name && !input?.sraNumber) result.errors.push('Either name or sraNumber is required.');
  result.valid = result.errors.length === 0;
  return result;
}

function createSraLookupTool(deps = {}) {
  const searchByName = deps.searchByName || defaultSearchByName;
  const findBySraNumber = deps.findBySraNumber || defaultFindBySraNumber;

  async function rawExecute(input) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('sra_lookup', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    if (input.sraNumber) {
      const result = await findBySraNumber(input.sraNumber);
      if (!result.ok) return failureResult('sra_lookup', { errorType: 'lookup_failed', error: result.error, retryable: false });
      return successResult('sra_lookup', { matched: true, matchConfidence: 'high', matchBasis: 'sra_number_lookup', firm: result.firm }, { provenance: { source: 'sra-snapshot-adapter', asOf: result.asOf } });
    }

    const result = await searchByName(input.name);
    if (!result.ok) return failureResult('sra_lookup', { errorType: 'lookup_failed', error: result.error, retryable: false });

    const results = result.results || [];
    if (results.length === 0) {
      return successResult('sra_lookup', { matched: false, matchConfidence: null, matchBasis: 'no_result', candidates: [] });
    }
    const exact = results.find((r) => r.name?.toLowerCase() === input.name.toLowerCase());
    if (exact) {
      return successResult('sra_lookup', { matched: true, matchConfidence: 'high', matchBasis: 'exact_name_match', firm: exact, candidates: results }, { provenance: { source: 'sra-snapshot-adapter', asOf: result.asOf } });
    }
    return successResult('sra_lookup', { matched: false, matchConfidence: 'low', matchBasis: 'name_search_candidate', candidates: results }, { provenance: { source: 'sra-snapshot-adapter', asOf: result.asOf } });
  }

  return {
    name: 'sra_lookup',
    description: 'Looks up a firm by name or SRA number against the SRA snapshot register. Read-only, no live API key required.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 10000,
    maxRetries: 0,
    execute: rawExecute,
  };
}

module.exports = { createSraLookupTool };
