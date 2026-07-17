'use strict';

// Brave Search API provider — the default active search provider for the
// Commercial Observatory Research Agent (replacing the now-non-viable
// Google Custom Search JSON API — see google-legacy-provider.js). Speaks
// only the provider-neutral contract defined in search-provider-contract.js;
// the planner, search-result selector and orchestrator never see anything
// Brave-specific.
//
// Brave's own AI-generated summary (if the API ever returns one) is never
// read or mapped here — only `web.results` (ordinary organic web results)
// become discovery aids. A result's title/snippet remain non-evidential:
// only fetch_web_page retrieving the destination URL can ever produce
// evidence.

const axios = require('axios');
const {
  validateProviderInput, clampMaxResults, normaliseResultUrl,
  buildProviderSuccessResult, buildProviderFailureResult,
} = require('./search-provider-contract');

const PROVIDER_NAME = 'brave';
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_TIMEOUT_MS = 10000;
const USER_AGENT = 'Soterius-Commercial-Observatory/1.0 (+research-agent; Brave Web Search)';

async function defaultHttpGet(url, { params, headers, timeout }) {
  return axios.get(url, { params, headers, timeout });
}

/**
 * Maps one Brave web-result item to the provider-neutral result shape.
 * Returns null for a malformed/unsupported URL so the caller can filter it
 * out — the position (rank) passed in is the item's ORIGINAL index in
 * Brave's own ordering, preserved even if later items get filtered out.
 */
function mapBraveResult(item, originalIndex) {
  const url = normaliseResultUrl(item && item.url);
  if (!url) return null;
  return {
    title: item.title || null,
    // Brave calls this field "description" — mapped honestly; if Brave
    // omits it for a result, snippet is null, never fabricated.
    snippet: item.description || null,
    url,
    source: PROVIDER_NAME,
    rank: originalIndex + 1,
    retrievedAt: new Date().toISOString(),
    providerMetadata: {
      language: item.language || null,
      isSourceLocal: item.is_source_local ?? null,
      familyFriendly: item.family_friendly ?? null,
    },
  };
}

function classifyError(err) {
  const status = err.response?.status;
  const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
  const isConnection = !status && !isTimeout;
  const retryable = isTimeout || isConnection || status >= 500 || status === 429;
  let errorType;
  if (status === 429) errorType = 'rate_limited';
  else if (status === 401 || status === 403) errorType = 'authentication_error';
  else if (status) errorType = 'http_error';
  else if (isTimeout) errorType = 'timeout';
  else errorType = 'connection_error';
  return { status: status ?? null, retryable, errorType };
}

/**
 * createBraveSearchProvider(deps) -> { name: 'brave', search(input) }
 *
 * deps: { apiKey, httpGet, timeoutMs, maxRetries } — all injectable for
 * tests; without them, reads BRAVE_SEARCH_API_KEY from process.env and uses
 * a real axios GET.
 */
function createBraveSearchProvider(deps = {}) {
  async function search(input) {
    const { valid, errors } = validateProviderInput(input);
    if (!valid) return buildProviderFailureResult(PROVIDER_NAME, input?.query, { errorType: 'invalid_input', error: errors.join('; '), retryable: false });

    const apiKey = deps.apiKey ?? process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return buildProviderFailureResult(PROVIDER_NAME, input.query, { errorType: 'not_configured', error: 'BRAVE_SEARCH_API_KEY not configured.', retryable: false });
    }

    const maxResults = clampMaxResults(input.maxResults);
    const q = input.domainRestriction ? `${input.query} site:${input.domainRestriction}` : input.query;

    const params = { q, count: maxResults };
    if (input.country) params.country = input.country;
    if (input.language) params.search_lang = input.language;
    if (input.safeSearch) params.safesearch = input.safeSearch;
    if (input.freshness) params.freshness = input.freshness;

    // The API key travels ONLY in the documented auth header — never in
    // query-string params, where it could leak into logs/proxies.
    const headers = {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'User-Agent': USER_AGENT,
      'X-Subscription-Token': apiKey,
    };

    const httpGet = deps.httpGet ?? defaultHttpGet;
    const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = deps.maxRetries ?? 1;

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await httpGet(BRAVE_ENDPOINT, { params, headers, timeout });
        const rawResults = (response.data && response.data.web && response.data.web.results) || [];
        const results = rawResults
          .map((item, index) => mapBraveResult(item, index))
          .filter(Boolean)
          .slice(0, maxResults);
        const requestId = (response.headers && (response.headers['x-request-id'] || response.headers['request-id'])) || null;
        return buildProviderSuccessResult(PROVIDER_NAME, q, results, {
          usage: { resultCount: results.length, requested: maxResults, attempts: attempt + 1 },
          requestId,
        });
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

  return { name: PROVIDER_NAME, search };
}

module.exports = { createBraveSearchProvider, PROVIDER_NAME, BRAVE_ENDPOINT };
