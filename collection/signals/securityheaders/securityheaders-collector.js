'use strict';

// SOT-SECURITYHEADERS-001 — HTTP Security Headers Signal
// Signal Lab v1 — observable facts only, no scoring, no interpretation.
//
// Transport: node:https (HTTPS primary) + node:http (HTTP probe).
// Fetch API rejected: Headers.entries() sorts alphabetically, merges duplicates,
// lowercases names — fails all three evidence preservation requirements.
//
// Evidence model:
//   https_fetch  — HttpsFetchResult (follows redirects, MAX_REDIRECTS=10)
//   http_probe   — HttpProbeFetchResult (single non-following request)
//   header_inventory — SecurityHeaderInventory (25 headers, from https_fetch)

const https = require('node:https');
const http  = require('node:http');

// ── Constants ─────────────────────────────────────────────────────────────────

const SIGNAL_VERSION    = 'SOT-SECURITYHEADERS-001-v1';
const COLLECTOR_VERSION = '1.0.0';
const MAX_REDIRECTS     = 10;
const TIMEOUT_MS        = 10_000;

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_HAS_EXPIRED',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_ALTNAME_FORMAT',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
]);

const SECURITY_HEADER_MAP = new Map([
  ['strict_transport_security',                'strict-transport-security'],
  ['content_security_policy',                  'content-security-policy'],
  ['content_security_policy_report_only',      'content-security-policy-report-only'],
  ['x_frame_options',                          'x-frame-options'],
  ['x_content_type_options',                   'x-content-type-options'],
  ['referrer_policy',                          'referrer-policy'],
  ['permissions_policy',                       'permissions-policy'],
  ['feature_policy',                           'feature-policy'],
  ['cross_origin_opener_policy',               'cross-origin-opener-policy'],
  ['cross_origin_opener_policy_report_only',   'cross-origin-opener-policy-report-only'],
  ['cross_origin_embedder_policy',             'cross-origin-embedder-policy'],
  ['cross_origin_embedder_policy_report_only', 'cross-origin-embedder-policy-report-only'],
  ['cross_origin_resource_policy',             'cross-origin-resource-policy'],
  ['reporting_endpoints',                      'reporting-endpoints'],
  ['report_to',                                'report-to'],
  ['nel',                                      'nel'],
  ['origin_agent_cluster',                     'origin-agent-cluster'],
  ['x_xss_protection',                         'x-xss-protection'],
  ['expect_ct',                                'expect-ct'],
  ['public_key_pins',                          'public-key-pins'],
  ['public_key_pins_report_only',              'public-key-pins-report-only'],
  ['server',                                   'server'],
  ['x_powered_by',                             'x-powered-by'],
  ['x_aspnet_version',                         'x-aspnet-version'],
  ['x_aspnetmvc_version',                      'x-aspnetmvc-version'],
]);

// ── Error classification ───────────────────────────────────────────────────────

function classifyError(err) {
  const name = err.name ?? '';
  const code = err.code ?? '';
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ETIMEDOUT') return 'TIMEOUT';
  if (TLS_ERROR_CODES.has(code) || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) return 'TLS_ERROR';
  return 'CONNECTION_ERROR';
}

// ── Header utilities ──────────────────────────────────────────────────────────

function buildHeaderPairs(rawHeaders) {
  const pairs = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    pairs.push({
      name_raw:  rawHeaders[i],
      value_raw: rawHeaders[i + 1],
      position:  (i / 2) + 1,
    });
  }
  return pairs;
}

function extractSecurityHeaders(headerPairs) {
  const inventory = {};
  for (const [fieldName, canonicalName] of SECURITY_HEADER_MAP) {
    const occurrences = headerPairs.filter(p => p.name_raw.toLowerCase() === canonicalName);
    if (occurrences.length === 0) {
      inventory[fieldName] = { present: false, count: 0, values: [], first_position: null };
    } else {
      inventory[fieldName] = {
        present:        true,
        count:          occurrences.length,
        values:         occurrences.map(p => p.value_raw),
        first_position: occurrences[0].position,
      };
    }
  }
  return inventory;
}

// ── Low-level request ─────────────────────────────────────────────────────────

// Default requestFn — wraps node:http / node:https in a promise.
// Returns { statusCode, rawHeaders, resume() } on success.
// Throws on error or timeout.
function makeDefaultRequestFn(transport) {
  return function defaultRequestFn(url) {
    return new Promise((resolve, reject) => {
      const parsed  = new URL(url);
      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || undefined,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers:  { 'User-Agent': 'Soterius-SignalLab/1.0 (+https://soterius.com)' },
        timeout:  TIMEOUT_MS,
      };

      const req = transport.request(options, (res) => {
        resolve({
          statusCode: res.statusCode,
          rawHeaders: res.rawHeaders,
          resume()   { res.resume(); },
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('Request timed out');
        err.name  = 'TimeoutError';
        reject(err);
      });

      req.on('error', reject);
      req.end();
    });
  };
}

const defaultHttpsRequestFn = makeDefaultRequestFn(https);
const defaultHttpRequestFn  = makeDefaultRequestFn(http);

// ── HTTPS fetch (follows redirects) ──────────────────────────────────────────

async function fetchEndpoint(domain, { requestFn = defaultHttpsRequestFn } = {}) {
  const startUrl       = `https://${domain}/`;
  const redirect_chain = [];
  let   currentUrl     = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await requestFn(currentUrl);
    } catch (err) {
      const outcome = classifyError(err);
      return {
        url:             currentUrl,
        fetch_outcome:   outcome,
        http_status:     null,
        redirect_chain,
        header_pairs:    [],
      };
    }

    res.resume();

    const { statusCode, rawHeaders } = res;
    const header_pairs = buildHeaderPairs(rawHeaders);

    if (statusCode >= 301 && statusCode <= 308) {
      const locationPair = header_pairs.find(p => p.name_raw.toLowerCase() === 'location');
      const location     = locationPair?.value_raw ?? null;

      redirect_chain.push({
        url:         currentUrl,
        http_status: statusCode,
        location,
      });

      if (!location) {
        return {
          url:           currentUrl,
          fetch_outcome: 'REDIRECT_UNRESOLVED',
          http_status:   statusCode,
          redirect_chain,
          header_pairs,
        };
      }

      if (hop === MAX_REDIRECTS) {
        return {
          url:           currentUrl,
          fetch_outcome: 'REDIRECT_UNRESOLVED',
          http_status:   statusCode,
          redirect_chain,
          header_pairs,
        };
      }

      try {
        currentUrl = new URL(location, currentUrl).href;
      } catch {
        return {
          url:           currentUrl,
          fetch_outcome: 'REDIRECT_UNRESOLVED',
          http_status:   statusCode,
          redirect_chain,
          header_pairs,
        };
      }

      continue;
    }

    return {
      url:           currentUrl,
      fetch_outcome: 'RESPONSE_OBSERVED',
      http_status:   statusCode,
      redirect_chain,
      header_pairs,
    };
  }

  // Unreachable — loop exits via return above.
  /* istanbul ignore next */
  return {
    url:           currentUrl,
    fetch_outcome: 'REDIRECT_UNRESOLVED',
    http_status:   null,
    redirect_chain,
    header_pairs:  [],
  };
}

// ── HTTP probe (single non-following request) ─────────────────────────────────

async function fetchProbe(domain, { requestFn = defaultHttpRequestFn } = {}) {
  const url = `http://${domain}/`;

  let res;
  try {
    res = await requestFn(url);
  } catch (err) {
    const outcome = classifyError(err);
    return {
      url,
      fetch_outcome: outcome,
      http_status:   null,
      redirect_chain: [],
      header_pairs:  [],
    };
  }

  res.resume();

  const { statusCode, rawHeaders } = res;
  const header_pairs = buildHeaderPairs(rawHeaders);

  return {
    url,
    fetch_outcome:  'RESPONSE_OBSERVED',
    http_status:    statusCode,
    redirect_chain: [],
    header_pairs,
  };
}

// ── Main collector ────────────────────────────────────────────────────────────

async function collectSecurityHeaders(domain, collectorVersion = COLLECTOR_VERSION, {
  httpsRequestFn = defaultHttpsRequestFn,
  httpRequestFn  = defaultHttpRequestFn,
} = {}) {
  const collected_at = new Date().toISOString();

  const [https_fetch, http_probe] = await Promise.all([
    fetchEndpoint(domain, { requestFn: httpsRequestFn }),
    fetchProbe(domain,    { requestFn: httpRequestFn  }),
  ]);

  const header_inventory = extractSecurityHeaders(https_fetch.header_pairs);

  return {
    domain,
    collected_at,
    signal_version:    SIGNAL_VERSION,
    collector_version: collectorVersion,
    endpoint_state:    https_fetch.fetch_outcome,
    http_probe_state:  http_probe.fetch_outcome,
    https_fetch,
    http_probe,
    header_inventory,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  collectSecurityHeaders,
  fetchEndpoint,
  fetchProbe,
  buildHeaderPairs,
  extractSecurityHeaders,
  classifyError,
  SECURITY_HEADER_MAP,
  TLS_ERROR_CODES,
  SIGNAL_VERSION,
  COLLECTOR_VERSION,
  MAX_REDIRECTS,
  TIMEOUT_MS,
};
