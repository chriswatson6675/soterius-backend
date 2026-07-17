'use strict';

// fca_lookup — a new, minimal single-firm lookup built directly on the
// ALREADY-EXISTING FCA transport client (collection/sources/fca/
// fca-client.js: loadConfig/buildUrl/getJson). No lighter single-lookup
// wrapper existed anywhere in the repository (only the full bulk-
// collection pipeline, which assumes an already-known FRN) — this is the
// smallest addition consistent with that existing transport, not a new
// FCA integration from scratch. Read-only; never writes.

const { loadConfig: defaultLoadConfig, buildUrl, getJson: defaultGetJson } = require('../../../collection/sources/fca/fca-client');
const { successResult, failureResult, validateInput } = require('./tool-contract');

const INPUT_SCHEMA = {
  required: ['name', 'investigationId'],
  properties: { name: { type: 'string' }, investigationId: { type: 'string' } },
};

function validate(input) {
  return validateInput(input, INPUT_SCHEMA);
}

function normaliseRecord(raw) {
  return {
    frn: raw.FRN ?? raw.frn ?? null,
    name: raw['Organisation Name'] ?? raw.Name ?? raw.name ?? null,
    status: raw.Status ?? raw.status ?? null,
    type: raw.Type ?? raw.type ?? null,
  };
}

function createFcaLookupTool(deps = {}) {
  const loadConfig = deps.loadConfig || defaultLoadConfig;
  const getJson = deps.getJson || defaultGetJson;

  async function rawExecute(input) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('fca_lookup', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    const config = loadConfig();
    if (!config.email || !config.apiKey) {
      return failureResult('fca_lookup', { errorType: 'not_configured', error: 'FCA_EMAIL / FCA_API_KEY not configured.', retryable: false });
    }

    const url = buildUrl(config.baseUrl, `/Search?q=${encodeURIComponent(input.name)}&type=firm`);
    const response = await getJson(url, { email: config.email, apiKey: config.apiKey });

    if (response.errorType !== 'NONE') {
      return failureResult('fca_lookup', { errorType: response.errorType.toLowerCase(), error: response.errorMessage || `FCA register returned ${response.errorType}`, retryable: response.errorType === 'RATE_LIMITED' });
    }

    const rawResults = response.body?.Data || [];
    if (rawResults.length === 0) {
      return successResult('fca_lookup', { matched: false, matchConfidence: null, matchBasis: 'no_result', candidates: [] });
    }

    const results = rawResults.map(normaliseRecord);
    const exact = results.find((r) => r.name && r.name.toLowerCase() === input.name.toLowerCase());
    if (exact) {
      return successResult('fca_lookup', { matched: true, matchConfidence: 'high', matchBasis: 'exact_name_match', firm: exact, candidates: results }, { provenance: { source: 'fca-register', endpoint: url } });
    }
    return successResult('fca_lookup', { matched: false, matchConfidence: 'low', matchBasis: 'name_search_candidate', candidates: results }, { provenance: { source: 'fca-register', endpoint: url } });
  }

  return {
    name: 'fca_lookup',
    description: 'Searches the FCA Financial Services Register for a firm by name. Read-only; never infers identity silently.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: 15000,
    maxRetries: 1,
    execute: rawExecute,
  };
}

module.exports = { createFcaLookupTool };
