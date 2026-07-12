'use strict';

// SOT-SECURITYHEADERS-001 — HTTP Security Headers Signal
// Signal Lab v2 — observable facts only, no scoring, no interpretation.
//
// ── SLG-136 harmonisation (COLLECT-PHILOSOPHY-v1.0, §7 R-1 + §10) ──────────────
// This collector is a PUBLIC OBSERVATIONAL collector (SLG-136 §3.1): it fetches
// publicly-served, non-credentialed HTTP headers and transmits no secret. Per
// the frozen collection philosophy it MUST observe the response even when the
// origin's TLS source-authentication fails, and MUST record that verdict
// inseparably from the evidence (C-4/C-7) with its specific cause (C-5) —
// exactly as the reference §3.1 collectors do (tls-collection-layer.js,
// MTA-STS pass 2). The v1 collector instead connected with the default
// rejectUnauthorized:true, so a failed certificate discarded BOTH the headers
// AND the verdict (endpoint_state=TLS_ERROR, empty header_pairs) — SLG-136 §4
// DEVIATION (C-4/C-7), the root of the 653-domain Security-Headers/TLS
// discrepancy. v2 fixes this:
//   - HTTPS connects permissively (rejectUnauthorized:false) so the response is
//     always observed regardless of certificate validity;
//   - the source-authentication verdict (tls_verification_result + specific
//     tls_error_code) is recorded inseparably inside https_fetch (and each
//     redirect hop) and mirrored to a normalised top-level field;
//   - genuine transport / TLS-protocol failures (handshake failure, reset,
//     protocol mismatch) STILL surface as a specifically-caused endpoint_state,
//     never a generic bucket (C-5).
// The verdict vocabulary mirrors tls-collection-layer.js exactly (the §3.1
// reference) so it is directly comparable across collectors. This collector
// still NEVER scores (C-8): the paired Quality Model disposition rule that
// decides how headers observed over a failed verdict are weighted (SLG-136 §7,
// constitutional) lives downstream in the Quality Model layer, not here.
//
// Transport: node:https (HTTPS primary, permissive) + node:http (HTTP probe).
// Fetch API rejected: Headers.entries() sorts alphabetically, merges duplicates,
// lowercases names — fails all three evidence preservation requirements.
//
// Evidence model:
//   https_fetch  — HttpsFetchResult (follows redirects, MAX_REDIRECTS=10; carries
//                  terminal tls_verification_result/tls_error_code; each redirect
//                  hop carries its own verdict)
//   http_probe   — HttpProbeFetchResult (single non-following request; no TLS verdict)
//   header_inventory — SecurityHeaderInventory (25 headers, from https_fetch)

const https = require('node:https');
const http  = require('node:http');

// ── Constants ─────────────────────────────────────────────────────────────────

const SIGNAL_VERSION    = 'SOT-SECURITYHEADERS-001-v2';
const COLLECTOR_VERSION = '2.0.0';
const MAX_REDIRECTS     = 10;
const TIMEOUT_MS        = 10_000;   // SLG-136 harmonisation: budget UNCHANGED from v1
                                    // (mechanism/provenance harmonised, not the timeout),
                                    // so the recovered-observation delta is attributable
                                    // to exactly the source-authentication change.

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

// Source-authentication verdict vocabulary. Mirrors tls-collection-layer.js's
// VERIFICATION_MAP exactly (the SLG-136 §3.1 reference implementation) so the
// verdict is directly comparable across collectors. Node exposes the verdict on
// the TLS socket as socket.authorized (boolean) + socket.authorizationError
// (an OpenSSL error-code string); this maps that code to the shared vocabulary.
const VERIFICATION_MAP = {
  CERT_HAS_EXPIRED:                  'CERT_EXPIRED',
  CERT_NOT_YET_VALID:                'CERT_NOT_YET_VALID',
  ERR_TLS_CERT_ALTNAME_INVALID:      'HOSTNAME_MISMATCH',
  DEPTH_ZERO_SELF_SIGNED_CERT:       'SELF_SIGNED',
  SELF_SIGNED_CERT_IN_CHAIN:         'SELF_SIGNED_IN_CHAIN',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:   'CHAIN_UNVERIFIABLE',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'CHAIN_UNVERIFIABLE',
  CERT_REVOKED:                      'CERT_REVOKED',
};

// Dedicated permissive HTTPS agent (SLG-136 §10). rejectUnauthorized:false lets
// the response be OBSERVED over an unauthenticated origin; the verdict is then
// read from the socket and recorded. keepAlive:false ensures one fresh TLS
// session per target so the recorded verdict describes that target only.
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

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

// ── Source-authentication verdict (C-4/C-7) ────────────────────────────────────

// Derives the source-authentication verdict from a connected socket. For a TLS
// socket, socket.authorized is a boolean and socket.authorizationError is the
// OpenSSL failure code (string) when it is false. For a plain TCP socket (the
// HTTP probe) there is no verdict — returns nulls. Never throws.
function deriveTlsVerdict(socket) {
  if (!socket || typeof socket.authorized !== 'boolean') {
    // Not a TLS socket (HTTP probe) — no source-authentication verdict exists.
    return { tls_verification_result: null, tls_error_code: null };
  }
  if (socket.authorized === true) {
    return { tls_verification_result: 'CHAIN_VERIFIED', tls_error_code: null };
  }
  const errorCode = socket.authorizationError;
  if (!errorCode) {
    return { tls_verification_result: 'UNKNOWN', tls_error_code: null };
  }
  const code   = typeof errorCode === 'string' ? errorCode : (errorCode.code ?? String(errorCode));
  const mapped = VERIFICATION_MAP[code];
  return { tls_verification_result: mapped || 'OTHER_TLS_ERROR', tls_error_code: code };
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
// Returns { statusCode, rawHeaders, tls_verification_result, tls_error_code,
// resume() } on success. Throws on error or timeout. The source-authentication
// verdict is derived here (from the connected socket) so that the injectable
// requestFn seam is the single place that produces it; fetchEndpoint/fetchProbe
// read it verbatim from the resolved object (mock requestFns supply it directly).
function makeDefaultRequestFn(transport, agent) {
  return function defaultRequestFn(url) {
    return new Promise((resolve, reject) => {
      const parsed  = new URL(url);
      const options = {
        hostname:   parsed.hostname,
        port:       parsed.port || undefined,
        path:       parsed.pathname + parsed.search,
        method:     'GET',
        headers:    { 'User-Agent': 'Soterius-SignalLab/2.0 (+https://soterius.com)' },
        timeout:    TIMEOUT_MS,
        servername: parsed.hostname,               // SNI — required for correct cert + HOSTNAME_MISMATCH detection
        rejectUnauthorized: false,                 // SLG-136 §3.1/§10 — observe first; verdict recorded, not gated
      };
      if (agent) options.agent = agent;

      const req = transport.request(options, (res) => {
        const verdict = deriveTlsVerdict(res.socket);
        resolve({
          statusCode:              res.statusCode,
          rawHeaders:              res.rawHeaders,
          tls_verification_result: verdict.tls_verification_result,
          tls_error_code:          verdict.tls_error_code,
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

const defaultHttpsRequestFn = makeDefaultRequestFn(https, insecureHttpsAgent);
const defaultHttpRequestFn  = makeDefaultRequestFn(http,  undefined);

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
      // Genuine transport / TLS-protocol failure (handshake failure, reset,
      // protocol mismatch) — no response observed, no source-authentication
      // verdict established. Specific cause preserved (C-5), never a generic bucket.
      const outcome = classifyError(err);
      return {
        url:                     currentUrl,
        fetch_outcome:           outcome,
        http_status:             null,
        redirect_chain,
        header_pairs:            [],
        tls_verification_result: null,
        tls_error_code:          null,
      };
    }

    res.resume();

    const { statusCode, rawHeaders } = res;
    const tls_verification_result = res.tls_verification_result ?? null;
    const tls_error_code          = res.tls_error_code ?? null;
    const header_pairs = buildHeaderPairs(rawHeaders);

    if (statusCode >= 301 && statusCode <= 308) {
      const locationPair = header_pairs.find(p => p.name_raw.toLowerCase() === 'location');
      const location     = locationPair?.value_raw ?? null;

      redirect_chain.push({
        url:                     currentUrl,
        http_status:             statusCode,
        location,
        tls_verification_result,               // per-hop verdict (C-4)
        tls_error_code,
      });

      if (!location) {
        return {
          url:                     currentUrl,
          fetch_outcome:           'REDIRECT_UNRESOLVED',
          http_status:             statusCode,
          redirect_chain,
          header_pairs,
          tls_verification_result,
          tls_error_code,
        };
      }

      if (hop === MAX_REDIRECTS) {
        return {
          url:                     currentUrl,
          fetch_outcome:           'REDIRECT_UNRESOLVED',
          http_status:             statusCode,
          redirect_chain,
          header_pairs,
          tls_verification_result,
          tls_error_code,
        };
      }

      try {
        currentUrl = new URL(location, currentUrl).href;
      } catch {
        return {
          url:                     currentUrl,
          fetch_outcome:           'REDIRECT_UNRESOLVED',
          http_status:             statusCode,
          redirect_chain,
          header_pairs,
          tls_verification_result,
          tls_error_code,
        };
      }

      continue;
    }

    return {
      url:                     currentUrl,
      fetch_outcome:           'RESPONSE_OBSERVED',
      http_status:             statusCode,
      redirect_chain,
      header_pairs,
      tls_verification_result,               // terminal verdict — the connection that served the observed headers
      tls_error_code,
    };
  }

  // Unreachable — loop exits via return above.
  /* istanbul ignore next */
  return {
    url:                     currentUrl,
    fetch_outcome:           'REDIRECT_UNRESOLVED',
    http_status:             null,
    redirect_chain,
    header_pairs:            [],
    tls_verification_result: null,
    tls_error_code:          null,
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
      fetch_outcome:  outcome,
      http_status:    null,
      redirect_chain: [],
      header_pairs:   [],
    };
  }

  res.resume();

  const { statusCode, rawHeaders } = res;
  const header_pairs = buildHeaderPairs(rawHeaders);

  // HTTP carries no TLS source-authentication verdict — not applicable.
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
    // Normalised top-level mirror of the terminal https_fetch source-authentication
    // verdict (C-4/C-7) — same mirroring pattern as endpoint_state, for query and
    // Quality Model segmentation. The inseparable copy lives inside https_fetch.
    tls_verification_result: https_fetch.tls_verification_result ?? null,
    tls_error_code:          https_fetch.tls_error_code ?? null,
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
  deriveTlsVerdict,
  SECURITY_HEADER_MAP,
  TLS_ERROR_CODES,
  VERIFICATION_MAP,
  SIGNAL_VERSION,
  COLLECTOR_VERSION,
  MAX_REDIRECTS,
  TIMEOUT_MS,
};
