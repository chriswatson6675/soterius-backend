'use strict';

// Search provider factory — the single place that decides which search
// provider (Brave, legacy Google, or none) actually serves a query. The
// planner, search-result selector and orchestrator never call a provider
// directly; they only ever go through search_web (tools/search-web.js),
// which asks this factory for whatever is configured.
//
// Selection rule (COMMERCIAL_OBSERVATORY_SEARCH_PROVIDER):
//   - "brave"         -> Brave Search API (the intended default)
//   - "google_legacy" -> deprecated Google Custom Search, explicit only
//   - "disabled"      -> search is explicitly turned off
//   - unset           -> Brave IF BRAVE_SEARCH_API_KEY is present,
//                        otherwise a clear search_provider_not_configured
//                        failure. Google is NEVER auto-selected, even if
//                        its (non-viable) credentials happen to be present
//                        — see google-legacy-provider.js for why.

const { createBraveSearchProvider } = require('./brave-search-provider');
const { createGoogleLegacyProvider } = require('./google-legacy-provider');
const { buildProviderFailureResult } = require('./search-provider-contract');

const SUPPORTED_PROVIDERS = Object.freeze(['brave', 'google_legacy', 'disabled']);

function notConfiguredProvider(reasonErrorType, message) {
  return {
    name: null,
    search: async (input) => buildProviderFailureResult(null, input && input.query, { errorType: reasonErrorType, error: message, retryable: false }),
  };
}

function unsupportedProvider(providerName) {
  return {
    name: providerName,
    search: async (input) => buildProviderFailureResult(providerName, input && input.query, {
      errorType: 'search_provider_unsupported', error: `Unsupported search provider "${providerName}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}.`, retryable: false,
    }),
  };
}

function disabledProvider() {
  return {
    name: 'disabled',
    search: async (input) => buildProviderFailureResult('disabled', input && input.query, { errorType: 'search_provider_disabled', error: 'Search is explicitly disabled (COMMERCIAL_OBSERVATORY_SEARCH_PROVIDER=disabled).', retryable: false }),
  };
}

/**
 * createSearchProvider(deps) -> { name, search(input) }
 *
 * deps: { providerName, braveApiKey, brave: {...}, googleLegacy: {...} } —
 * all injectable for tests. Without overrides, reads
 * COMMERCIAL_OBSERVATORY_SEARCH_PROVIDER and BRAVE_SEARCH_API_KEY from
 * process.env.
 */
function createSearchProvider(deps = {}) {
  const configuredProviderName = deps.providerName ?? process.env.COMMERCIAL_OBSERVATORY_SEARCH_PROVIDER ?? null;
  const braveKeyPresent = !!(deps.braveApiKey ?? (deps.brave && deps.brave.apiKey) ?? process.env.BRAVE_SEARCH_API_KEY);

  let providerName = configuredProviderName;
  if (!providerName) {
    providerName = braveKeyPresent ? 'brave' : null;
  }

  if (!providerName) {
    return notConfiguredProvider('search_provider_not_configured', 'No search provider configured. Set COMMERCIAL_OBSERVATORY_SEARCH_PROVIDER=brave (or google_legacy/disabled) and/or BRAVE_SEARCH_API_KEY.');
  }

  if (!SUPPORTED_PROVIDERS.includes(providerName)) return unsupportedProvider(providerName);
  if (providerName === 'disabled') return disabledProvider();
  if (providerName === 'google_legacy') return createGoogleLegacyProvider(deps.googleLegacy || {});
  return createBraveSearchProvider(deps.brave || {});
}

module.exports = { createSearchProvider, SUPPORTED_PROVIDERS };
