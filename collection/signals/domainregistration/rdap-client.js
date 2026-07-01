'use strict';

// rdap-client.js — RDAP HTTP client with redirect tracking and rate management
//
// Single public function: queryRdap(queryUrl, rdapBaseUrl, rateManager, options)
// Returns a raw HTTP result object. Never rejects.
//
// Collection boundary (SOT-DOMAINREGISTRATION-001 §5.3 + SLG-011):
//   - Follows HTTP 301/302 Location redirects (protocol-mandated, RFC 7480 §5.2)
//   - Does NOT follow links[] rel="related" referral links (protocol-optional)
//   - Maximum redirect depth: 5
//
// Authority: COL-DOMAINREGISTRATION-001 Part 4 — RDAP Acquisition Design

const https = require('node:https');
const http  = require('node:http');

// ── Constants ─────────────────────────────────────────────────────────────────

const USER_AGENT = 'Soterius-SignalLab/1.0 (signal:domainregistration;version:1.4)';
const ACCEPT     = 'application/rdap+json';
const MAX_REDIRECTS = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RETRY = 1;

// Error codes that classify as CONNECTION_ERROR (vs RDAP_ERROR)
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ECONNABORTED', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL',
]);

// ── Rate manager factory ──────────────────────────────────────────────────────

/**
 * Creates a rate manager that enforces per-registry inter-request delays.
 * Keyed by RDAP base URL. Respects Retry-After headers on 429 responses.
 * Includes circuit-breaker: after 3 consecutive 429s, suspends for 120s.
 *
 * @param {Object} [config]
 * @param {number} [config.defaultDelayMs=500] - Default inter-request delay
 * @param {Object} [config.registryDelays={}] - Base URL → custom delay (ms)
 * @returns {RateManager}
 */
function createRateManager(config = {}) {
  const defaultDelay    = config.defaultDelayMs ?? 500;
  const registryDelays  = config.registryDelays ?? {};

  // Per-registry state
  const lastRequestAt   = new Map(); // rdapBaseUrl → timestamp ms
  const retryAfterUntil = new Map(); // rdapBaseUrl → timestamp ms (suspension end)
  const consecutive429  = new Map(); // rdapBaseUrl → count

  return {
    /**
     * Waits until it is safe to make a request to the given registry.
     * @param {string} rdapBaseUrl
     */
    async waitForSlot(rdapBaseUrl) {
      // Circuit breaker: suspended registry
      const suspendedUntil = retryAfterUntil.get(rdapBaseUrl) ?? 0;
      const now = Date.now();
      if (suspendedUntil > now) {
        await _sleep(suspendedUntil - now);
      }

      // Inter-request delay
      const delay = registryDelays[rdapBaseUrl] ?? defaultDelay;
      const last  = lastRequestAt.get(rdapBaseUrl) ?? 0;
      const elapsed = Date.now() - last;
      if (elapsed < delay) {
        await _sleep(delay - elapsed);
      }

      lastRequestAt.set(rdapBaseUrl, Date.now());
    },

    /**
     * Records a 429 response. Parses Retry-After header.
     * Activates circuit breaker after 3 consecutive 429s.
     * @param {string} rdapBaseUrl
     * @param {Object} headers - Response headers
     */
    record429(rdapBaseUrl, headers) {
      const count = (consecutive429.get(rdapBaseUrl) ?? 0) + 1;
      consecutive429.set(rdapBaseUrl, count);

      const retryAfterSec = _parseRetryAfter(headers['retry-after']);
      const waitMs = retryAfterSec != null
        ? Math.ceil(retryAfterSec * 1000 * 1.1)  // +10% buffer
        : (count >= 3 ? 120000 : 0);

      if (waitMs > 0) {
        retryAfterUntil.set(rdapBaseUrl, Date.now() + waitMs);
      }
    },

    /** Clears the 429 counter for a registry on a successful response. */
    recordSuccess(rdapBaseUrl) {
      consecutive429.delete(rdapBaseUrl);
    },
  };
}

// ── Main query function ───────────────────────────────────────────────────────

/**
 * Executes an RDAP query. Applies rate management, follows protocol-mandated
 * redirects, retries on transient errors. Never rejects.
 *
 * @param {string} queryUrl - Full RDAP query URL
 * @param {string} rdapBaseUrl - Registry base URL (for rate management keying)
 * @param {RateManager} rateManager
 * @param {Object} [options]
 * @param {number} [options.connectTimeoutMs]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.maxRetry]
 * @returns {Promise<RawHttpResult>}
 */
async function queryRdap(queryUrl, rdapBaseUrl, rateManager, options = {}) {
  const connectTimeout = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const requestTimeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxRetry       = options.maxRetry ?? DEFAULT_MAX_RETRY;

  let lastResult = null;

  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    await rateManager.waitForSlot(rdapBaseUrl);

    lastResult = await _executeRequest(queryUrl, rdapBaseUrl, {
      connectTimeout,
      requestTimeout,
    });

    // No retry on definitive responses
    if (lastResult.errorType === 'NONE') {
      rateManager.recordSuccess(rdapBaseUrl);
      return lastResult;
    }

    // 429: record and will retry after rate manager wait
    if (lastResult.httpStatus === 429) {
      rateManager.record429(rdapBaseUrl, lastResult.responseHeaders ?? {});
      if (attempt < maxRetry) continue;
      return lastResult;
    }

    // 4xx (non-429): no retry
    if (lastResult.httpStatus != null && lastResult.httpStatus >= 400 && lastResult.httpStatus < 500) {
      return lastResult;
    }

    // 5xx or CONNECTION_ERROR: retry once
    if (attempt < maxRetry) {
      await _sleep(attempt === 0 ? 2000 : 3000);
      continue;
    }
  }

  return lastResult;
}

// ── HTTP request with redirect tracking ──────────────────────────────────────

async function _executeRequest(initialUrl, rdapBaseUrl, options) {
  let currentUrl    = initialUrl;
  const redirectChain = [initialUrl];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop === MAX_REDIRECTS) {
      return {
        errorType:       'RDAP_ERROR',
        errorCode:       'MAX_REDIRECTS_EXCEEDED',
        errorMessage:    `Exceeded ${MAX_REDIRECTS} redirects`,
        httpStatus:      null,
        responseBody:    null,
        responseHeaders: null,
        rdapBaseUrl,
        redirectChain,
      };
    }

    const result = await _httpGet(currentUrl, options);

    if (result.error) {
      const isConnErr = CONNECTION_ERROR_CODES.has(result.error.code ?? '');
      return {
        errorType:       isConnErr ? 'CONNECTION_ERROR' : 'RDAP_ERROR',
        errorCode:       result.error.code ?? 'UNKNOWN',
        errorMessage:    result.error.message ?? String(result.error),
        httpStatus:      null,
        responseBody:    null,
        responseHeaders: null,
        rdapBaseUrl,
        redirectChain,
      };
    }

    const { statusCode, headers, body } = result;

    // Protocol-mandated redirect
    if ((statusCode === 301 || statusCode === 302) && headers.location) {
      const nextUrl = _resolveUrl(headers.location, currentUrl);
      redirectChain.push(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    // Successful response
    if (statusCode === 200) {
      return {
        errorType:       'NONE',
        errorCode:       null,
        errorMessage:    null,
        httpStatus:      200,
        responseBody:    body,
        responseHeaders: headers,
        rdapBaseUrl,
        redirectChain,
      };
    }

    // 404
    if (statusCode === 404) {
      return {
        errorType:       'DOMAIN_NOT_FOUND',
        errorCode:       'HTTP_404',
        errorMessage:    'Domain not found in registry',
        httpStatus:      404,
        responseBody:    body,
        responseHeaders: headers,
        rdapBaseUrl,
        redirectChain,
      };
    }

    // Any other status (4xx, 5xx, etc.)
    return {
      errorType:       'RDAP_ERROR',
      errorCode:       `HTTP_${statusCode}`,
      errorMessage:    `RDAP server returned HTTP ${statusCode}`,
      httpStatus:      statusCode,
      responseBody:    body,
      responseHeaders: headers,
      rdapBaseUrl,
      redirectChain,
    };
  }

  // Unreachable — loop guard above handles MAX_REDIRECTS
  /* istanbul ignore next */
  return {
    errorType: 'RDAP_ERROR', errorCode: 'LOOP_EXHAUSTED', errorMessage: 'Redirect loop guard',
    httpStatus: null, responseBody: null, responseHeaders: null, rdapBaseUrl, redirectChain,
  };
}

// ── HTTP GET helper ───────────────────────────────────────────────────────────

function _httpGet(url, options) {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   'GET',
      headers: {
        'Accept':     ACCEPT,
        'User-Agent': USER_AGENT,
      },
      timeout: options.connectTimeout,
    };

    const req = transport.request(reqOptions, (res) => {
      const chunks = [];
      const timer  = setTimeout(() => {
        req.destroy(new Error('Response body timeout'));
      }, options.requestTimeout);

      res.on('data',  chunk => chunks.push(chunk));
      res.on('end',   () => {
        clearTimeout(timer);
        resolve({
          statusCode: res.statusCode,
          headers:    res.headers,
          body:       Buffer.concat(chunks).toString('utf8'),
          error:      null,
        });
      });
      res.on('error', err => { clearTimeout(timer); resolve({ error: err }); });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ error: Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' }) });
    });

    req.on('error', err => resolve({ error: err }));
    req.end();
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _resolveUrl(location, base) {
  try {
    return new URL(location, base).toString();
  } catch {
    return location;
  }
}

function _parseRetryAfter(value) {
  if (!value) return null;
  const n = Number(value);
  if (!isNaN(n)) return n;
  const d = new Date(value);
  if (!isNaN(d.getTime())) return Math.max(0, (d.getTime() - Date.now()) / 1000);
  return null;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { queryRdap, createRateManager };

/**
 * @typedef {Object} RawHttpResult
 * @property {'NONE'|'CONNECTION_ERROR'|'RDAP_ERROR'|'DOMAIN_NOT_FOUND'} errorType
 * @property {string|null} errorCode
 * @property {string|null} errorMessage
 * @property {number|null} httpStatus
 * @property {string|null} responseBody
 * @property {Object|null} responseHeaders
 * @property {string} rdapBaseUrl
 * @property {string[]} redirectChain
 */

/**
 * @typedef {Object} RateManager
 * @property {function(string): Promise<void>} waitForSlot
 * @property {function(string, Object): void} record429
 * @property {function(string): void} recordSuccess
 */
