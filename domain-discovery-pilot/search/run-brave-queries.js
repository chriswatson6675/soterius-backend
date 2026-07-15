'use strict';

// run-brave-queries.js — runs the Domain Discovery Pilot's fixed query
// templates through the existing Brave search provider
// (commercial-observatory/agent/search/create-search-provider.js), capturing
// the FULL raw Brave response for persistence while still returning the
// provider's normal normalised result shape to the caller. Reuses the
// provider's own injectable httpGet hook — this module never speaks HTTP
// directly and never reimplements Brave's request signing.

const { createSearchProvider } = require('../../commercial-observatory/agent/search/create-search-provider');
const { normaliseDomain } = require('../../authority/lib/normalise');
const { EXCLUDED_DOMAINS, isExcludedDomain } = require('../query/query-templates');

/**
 * capturingHttpGet(realHttpGet) -> httpGet(url, config) that forwards to
 * realHttpGet exactly as before, but stashes the last raw response on the
 * returned wrapper object's `.lastRawResponse` for the caller to read.
 */
function capturingHttpGet(realHttpGet) {
  const state = { lastRawResponse: null };
  const wrapped = async (url, config) => {
    const response = await realHttpGet(url, config);
    state.lastRawResponse = response && response.data !== undefined ? response.data : response;
    return response;
  };
  wrapped.state = state;
  return wrapped;
}

/**
 * runBraveQueries(queries, deps) -> [{ queryTemplateVersion, queryString,
 *   success, rawResponse, requestId, usableResults, allResults, error }]
 *
 * deps: { httpGet, apiKey, providerName } — all injectable for offline tests.
 * queries: [{ queryTemplateVersion, queryString }] (query-templates.js shape
 * OR the { templateId, query } shape both tolerated).
 */
async function runBraveQueries(queries, deps = {}) {
  const httpGet = capturingHttpGet(deps.httpGet || requireDefaultHttpGet());
  const provider = createSearchProvider({
    providerName: deps.providerName || 'brave',
    brave: { httpGet, apiKey: deps.apiKey },
  });

  const out = [];
  for (const q of queries) {
    const queryString = q.queryString || q.query;
    const queryTemplateVersion = q.queryTemplateVersion || q.templateId;
    const result = await provider.search({ query: queryString });

    const allResults = result.success ? result.results : [];
    const usableResults = allResults
      .map((r) => ({ ...r, normalisedDomain: normaliseDomain(r.url) }))
      .filter((r) => r.normalisedDomain && !isExcludedDomain(r.normalisedDomain));

    out.push({
      queryTemplateVersion,
      queryString,
      success: result.success,
      rawResponse: httpGet.state.lastRawResponse,
      requestId: result.requestId ?? null,
      allResults,
      usableResults,
      error: result.success ? null : { errorType: result.errorType, error: result.error, retryable: result.retryable },
    });
    httpGet.state.lastRawResponse = null;
  }
  return out;
}

function requireDefaultHttpGet() {
  const axios = require('axios');
  return (url, config) => axios.get(url, config);
}

module.exports = { runBraveQueries, capturingHttpGet, EXCLUDED_DOMAINS };
