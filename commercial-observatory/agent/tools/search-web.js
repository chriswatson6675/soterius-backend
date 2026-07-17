'use strict';

// search_web — a controlled, bounded, auditable web-search tool.
//
// Provider-neutral: this tool never talks to a search API directly. It
// obtains an active provider from the factory
// (../search/create-search-provider.js — Brave by default, legacy Google
// only if explicitly selected, or a clear not-configured failure) and maps
// straight through to the provider-neutral result shape. The planner,
// search-result selector (search-result-selection.js) and orchestrator
// never need to know which provider actually served a query.
//
// Results are DISCOVERY AIDS ONLY — a title/snippet/URL is never itself
// persisted as evidence. Only after `fetch_web_page` retrieves and
// preserves the linked page does anything from a search result become
// citable.

const { successResult, failureResult, validateInput } = require('./tool-contract');
const { createSearchProvider } = require('../search/create-search-provider');
const { MAX_RESULTS_CAP } = require('../search/search-provider-contract');

const INPUT_SCHEMA = {
  required: ['query', 'investigationId'],
  properties: {
    query: { type: 'string' },
    siteRestrict: { type: 'string', optional: true },
    maxResults: { type: 'number', optional: true },
    country: { type: 'string', optional: true },
    language: { type: 'string', optional: true },
    safeSearch: { type: 'string', optional: true },
    freshness: { type: 'string', optional: true },
    investigationId: { type: 'string' },
  },
};

function validate(input) {
  return validateInput(input, INPUT_SCHEMA);
}

/**
 * search_web tool. `deps.provider` is injectable for tests — a full
 * provider-neutral `{ name, search(input) }` object bypasses the factory
 * entirely. Without it, the tool asks create-search-provider.js for
 * whichever provider is actually configured (`deps` is passed straight
 * through to the factory, so `deps.providerName`/`deps.brave`/
 * `deps.googleLegacy` overrides from tests work exactly as they do there).
 */
function createSearchWebTool(deps = {}) {
  const provider = deps.provider ?? createSearchProvider(deps);

  async function rawExecute(input, context = {}) {
    const { valid, errors } = validate(input);
    if (!valid) return failureResult('search_web', { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    const providerInput = {
      query: input.query,
      maxResults: input.maxResults,
      domainRestriction: input.siteRestrict,
      country: input.country,
      language: input.language,
      safeSearch: input.safeSearch,
      freshness: input.freshness,
    };

    const providerResult = await provider.search(providerInput);

    if (!providerResult.success) {
      return failureResult('search_web', { errorType: providerResult.errorType, error: providerResult.error, retryable: providerResult.retryable });
    }

    return successResult('search_web', {
      query: providerResult.query,
      results: providerResult.results,
      provider: providerResult.provider,
    }, {
      provenance: { query: providerResult.query, provider: providerResult.provider, resultCount: providerResult.results.length, requestId: providerResult.requestId ?? null },
      costMetadata: providerResult.usage || null,
    });
  }

  return {
    name: 'search_web',
    description: 'Searches the public web via the configured search provider (Brave by default). Returns discovery aids (title/url/snippet) only — never itself evidence.',
    inputSchema: INPUT_SCHEMA,
    validateInput: validate,
    timeoutMs: deps.timeoutMs ?? 10000,
    maxRetries: deps.maxRetries ?? 1,
    execute: rawExecute,
  };
}

module.exports = { createSearchWebTool, MAX_RESULTS_CAP };
