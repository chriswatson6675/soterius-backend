'use strict';

// Provider-neutral search contract for the Commercial Observatory Research
// Agent. Every search provider (Brave, legacy Google, any future provider)
// speaks this shape and nothing else — the planner, search-result selector
// and orchestrator only ever see this, never a provider-specific response.
//
// A search result is a DISCOVERY AID ONLY. Its title/snippet are never
// evidence — only after `fetch_web_page` retrieves and preserves the
// destination URL does anything from a result become citable. This module
// never attaches an evidenceId/persisted flag to a result; that absence is
// itself the non-evidential marker downstream code and tests check for.

const MAX_RESULTS_CAP = 10;
const DEFAULT_MAX_RESULTS = 5;

const PROVIDER_INPUT_SCHEMA = Object.freeze({
  required: ['query'],
  optional: ['maxResults', 'country', 'language', 'safeSearch', 'freshness', 'domainRestriction'],
});

function validateProviderInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { valid: false, errors: ['Provider input must be an object.'] };
  if (typeof input.query !== 'string' || input.query.trim().length === 0) errors.push('query is required and must be a non-empty string.');
  if (input.maxResults !== undefined && typeof input.maxResults !== 'number') errors.push('maxResults must be a number.');
  for (const field of ['country', 'language', 'safeSearch', 'freshness', 'domainRestriction']) {
    if (input[field] !== undefined && typeof input[field] !== 'string') errors.push(`${field} must be a string.`);
  }
  return { valid: errors.length === 0, errors };
}

/** Caps a requested result count at MAX_RESULTS_CAP, defaulting honestly when omitted. */
function clampMaxResults(requested) {
  const n = typeof requested === 'number' && requested > 0 ? requested : DEFAULT_MAX_RESULTS;
  return Math.min(n, MAX_RESULTS_CAP);
}

/**
 * Normalises a raw result URL, rejecting anything unparseable or using an
 * unsupported protocol (only http/https are ever followed downstream by
 * fetch_web_page, so a mailto:/javascript:/ftp: link is not a usable
 * discovery aid at all).
 */
function normaliseResultUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Builds the provider-neutral success envelope. `results` must already be
 * shaped as { title, url, snippet, source, rank, retrievedAt,
 * providerMetadata } — this function does not itself map provider-specific
 * fields (that is each provider's own job) but does defend the envelope
 * shape and strips anything that looks like a credential from
 * providerMetadata as a last line of defence.
 */
function buildProviderSuccessResult(provider, query, results, { usage = null, requestId = null } = {}) {
  return {
    success: true,
    provider,
    query,
    results: (results || []).map(sanitiseResultMetadata),
    usage: usage || {},
    requestId: requestId ?? null,
  };
}

function buildProviderFailureResult(provider, query, { errorType, error, status = null, retryable = false }) {
  return { success: false, provider, query, errorType, error, status, retryable };
}

const SECRET_KEY_PATTERN = /key|token|secret|authorization|password|credential/i;

/** Strips anything credential-shaped out of a result's providerMetadata before it ever leaves this module. */
function sanitiseResultMetadata(result) {
  if (!result || typeof result !== 'object') return result;
  const providerMetadata = result.providerMetadata && typeof result.providerMetadata === 'object'
    ? Object.fromEntries(Object.entries(result.providerMetadata).filter(([k]) => !SECRET_KEY_PATTERN.test(k)))
    : result.providerMetadata ?? null;
  return { ...result, providerMetadata };
}

module.exports = {
  MAX_RESULTS_CAP,
  DEFAULT_MAX_RESULTS,
  PROVIDER_INPUT_SCHEMA,
  validateProviderInput,
  clampMaxResults,
  normaliseResultUrl,
  buildProviderSuccessResult,
  buildProviderFailureResult,
};
