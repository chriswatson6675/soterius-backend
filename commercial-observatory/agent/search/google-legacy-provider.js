'use strict';

// DEPRECATED — Google Custom Search JSON API legacy provider.
//
// Google's Custom Search JSON API is closed to new customers and this
// project's configured key/CX is confirmed rejected (HTTP 403
// PERMISSION_DENIED, "This project does not have the access to Custom
// Search JSON API") — see the repository's own dated record of this in
// docs/company/acquisition/ACQ-002. This provider is retained ONLY for an
// already-authorised project that still has working access; it is never
// selected automatically (see ../search/create-search-provider.js) and
// requires an explicit COMMERCIAL_OBSERVATORY_SEARCH_PROVIDER=google_legacy.
// Brave (brave-search-provider.js) is the default active provider.
//
// The known 403 is handled as an ordinary structured provider failure, not
// a crash — exactly like every other provider failure mode.

const axios = require('axios');
const {
  validateProviderInput, clampMaxResults, normaliseResultUrl,
  buildProviderSuccessResult, buildProviderFailureResult,
} = require('./search-provider-contract');

const PROVIDER_NAME = 'google_legacy';
const PROVIDER_METADATA = Object.freeze({ deprecated: true, reason: 'Google Custom Search JSON API is closed to new customers.', since: '2026-06-15' });
const SEARCH_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const DEFAULT_TIMEOUT_MS = 10000;

async function defaultHttpGet(url, params, timeoutMs) {
  return axios.get(url, { params, timeout: timeoutMs });
}

function classifyError(err) {
  const status = err.response?.status;
  const retryable = !status || status >= 500 || status === 429;
  const errorType = status === 429 ? 'rate_limited' : (status === 401 || status === 403 ? 'authentication_error' : (status ? 'http_error' : 'connection_error'));
  return { status: status ?? null, retryable, errorType };
}

/**
 * createGoogleLegacyProvider(deps) -> { name: 'google_legacy', search(input), metadata }
 *
 * deps: { apiKey, searchEngineId, httpGet, timeoutMs, maxRetries } —
 * injectable for tests; otherwise reads GOOGLE_SEARCH_API_KEY /
 * GOOGLE_SEARCH_CX from process.env.
 */
function createGoogleLegacyProvider(deps = {}) {
  async function search(input) {
    const { valid, errors } = validateProviderInput(input);
    if (!valid) return buildProviderFailureResult(PROVIDER_NAME, input?.query, { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    const apiKey = deps.apiKey ?? process.env.GOOGLE_SEARCH_API_KEY;
    const searchEngineId = deps.searchEngineId ?? process.env.GOOGLE_SEARCH_CX;
    if (!apiKey || !searchEngineId) {
      return buildProviderFailureResult(PROVIDER_NAME, input.query, { errorType: 'not_configured', error: 'GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_CX not configured.', retryable: false });
    }

    const maxResults = clampMaxResults(input.maxResults);
    const q = input.domainRestriction ? `${input.query} site:${input.domainRestriction}` : input.query;
    const httpGet = deps.httpGet ?? defaultHttpGet;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = deps.maxRetries ?? 1;

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await httpGet(SEARCH_ENDPOINT, { key: apiKey, cx: searchEngineId, q, num: maxResults }, timeoutMs);
        const items = (response.data && response.data.items) || [];
        const results = items
          .map((item, index) => {
            const url = normaliseResultUrl(item.link);
            if (!url) return null;
            return {
              title: item.title || null, url, snippet: item.snippet || null,
              source: PROVIDER_NAME, rank: index + 1, retrievedAt: new Date().toISOString(),
              providerMetadata: {},
            };
          })
          .filter(Boolean)
          .slice(0, maxResults);
        return buildProviderSuccessResult(PROVIDER_NAME, q, results, { usage: { resultCount: results.length, requested: maxResults, attempts: attempt + 1 } });
      } catch (err) {
        lastError = err;
        const { status, retryable, errorType } = classifyError(err);
        if (!retryable || attempt >= maxRetries) {
          return { ...buildProviderFailureResult(PROVIDER_NAME, q, { errorType, error: err.message, status, retryable }), attempts: attempt + 1 };
        }
      }
    }
    return { ...buildProviderFailureResult(PROVIDER_NAME, q, { errorType: 'unknown_error', error: lastError?.message || 'search failed', retryable: false }), attempts: maxRetries + 1 };
  }

  return { name: PROVIDER_NAME, search, metadata: PROVIDER_METADATA };
}

module.exports = { createGoogleLegacyProvider, PROVIDER_NAME, PROVIDER_METADATA };
