'use strict';

// ch-client.js — Companies House API HTTP client (transport only)
//
// Implements the transport mechanics the CCS-COMPHOUSE-001 collector needs to
// execute the Observe operation against the Companies House collection surfaces
// (ESD-COMPHOUSE-001 §4): the Public Data API (PDA, REST/JSON) and the
// Document API (DOC, two-step metadata + binary).
//
// This module is PURE TRANSPORT. It assigns no meaning, preserves nothing, and
// makes no observation/evidence decisions — those belong to the collector
// (CCS §1: "a faithful executor of the observation contract, not a place where
// meaning is assigned"). It returns raw results; the collector classifies them.
//
// Constraints honoured (ESD §4.5):
//   - API-key auth is HTTP Basic with the key as username and an empty password.
//     This authenticates the *calling application*, not access to the target —
//     the zero-access public-observation principle is intact.
//   - Combined rate budget 600 requests / 5 minutes → a per-request floor delay
//     plus a 429 circuit breaker that honours Retry-After.
//   - Never throws: every outcome (success, 404, 410, 429, network error) is a
//     structured result the collector turns into an observation or a recorded
//     non-observation.
//
// Authority: CCS-COMPHOUSE-001 Part 2 (modes/surfaces), Part 3 (endpoints),
//   Part 6 (failure behaviour); ESD-COMPHOUSE-001 §4.

const https = require('node:https');
const http  = require('node:http');

const USER_AGENT = 'Soterius-SignalLab/1.0 (source:companies-house; spec:CCS-COMPHOUSE-001)';
const PDA_HOST    = 'api.company-information.service.gov.uk';
const DOC_HOST    = 'document-api.company-information.service.gov.uk';
const STREAM_HOST = 'stream.company-information.service.gov.uk';

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRY          = 1;
const MAX_REDIRECTS              = 5;

// 600 req / 5 min = 1 req / 500ms. Floor at 520ms for headroom.
const DEFAULT_INTER_REQUEST_MS = 520;
const RATE_BREAKER_DEFAULT_MS  = 60000;

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ECONNABORTED', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL',
]);

// ── Rate manager ───────────────────────────────────────────────────────────────

/**
 * Enforces the Companies House combined rate budget across all hosts (the budget
 * is per API key, not per host — ESD §4.5). Honours Retry-After on 429 and
 * suspends briefly after repeated 429s.
 *
 * @param {Object} [config]
 * @param {number} [config.interRequestMs=520]
 * @returns {RateManager}
 */
function createRateManager(config = {}) {
  const interRequestMs = config.interRequestMs ?? DEFAULT_INTER_REQUEST_MS;
  let lastRequestAt = 0;
  let suspendedUntil = 0;
  // Injected clock/sleep keep the manager testable without real time.
  const now   = config._now   ?? (() => Date.now());
  const sleep = config._sleep ?? _sleep;

  return {
    async waitForSlot() {
      const t = now();
      if (suspendedUntil > t) await sleep(suspendedUntil - t);
      const elapsed = now() - lastRequestAt;
      if (elapsed < interRequestMs) await sleep(interRequestMs - elapsed);
      lastRequestAt = now();
    },
    record429(headers) {
      const retryAfterSec = _parseRetryAfter((headers || {})['retry-after']);
      const waitMs = retryAfterSec != null
        ? Math.ceil(retryAfterSec * 1000 * 1.1)
        : RATE_BREAKER_DEFAULT_MS;
      suspendedUntil = now() + waitMs;
    },
  };
}

// ── Public: JSON GET (Public Data API) ─────────────────────────────────────────

/**
 * GETs a PDA JSON resource. Never rejects.
 *
 * @param {string} url - absolute URL
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {RateManager} [opts.rateManager]
 * @param {function} [opts._fetch] - injectable transport for tests
 * @returns {Promise<JsonResult>}
 */
async function getJson(url, opts = {}) {
  const res = await _requestWithPolicy(url, { ...opts, accept: 'application/json', binary: false });
  let parsed = null;
  let parseError = null;
  if (res.errorType === 'NONE' && res.bodyText != null && res.bodyText.length > 0) {
    try { parsed = JSON.parse(res.bodyText); }
    catch (e) { parseError = e.message; }
  }
  return {
    errorType:   parseError ? 'PARSE_ERROR' : res.errorType,
    httpStatus:  res.httpStatus,
    requestUri:  res.requestUri,
    etag:        parsed && typeof parsed === 'object' ? (parsed.etag ?? res.etag ?? null) : (res.etag ?? null),
    body:        parsed,
    headers:     res.headers,
    errorMessage: parseError ?? res.errorMessage,
  };
}

// ── Public: binary GET (Document API content) ──────────────────────────────────

/**
 * GETs a document content representation. Sends an Accept header selecting the
 * representation (e.g. application/pdf, application/xhtml+xml). Follows redirects
 * (CH serves content via a signed redirect). Never rejects.
 *
 * @param {string} url
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.accept='application/pdf']
 * @param {RateManager} [opts.rateManager]
 * @param {function} [opts._fetch]
 * @returns {Promise<BinaryResult>}
 */
async function getBinary(url, opts = {}) {
  const accept = opts.accept ?? 'application/pdf';
  const res = await _requestWithPolicy(url, { ...opts, accept, binary: true, followRedirects: true });
  return {
    errorType:    res.errorType,
    httpStatus:   res.httpStatus,
    requestUri:   res.requestUri,
    contentType:  res.headers ? (res.headers['content-type'] ?? null) : null,
    bytes:        res.errorType === 'NONE' ? res.bodyBuffer : null,
    headers:      res.headers,
    errorMessage: res.errorMessage,
  };
}

// ── Request policy (auth + rate + retry + classification) ──────────────────────

async function _requestWithPolicy(url, opts) {
  const apiKey   = opts.apiKey;
  const maxRetry = opts.maxRetry ?? DEFAULT_MAX_RETRY;
  const rateManager = opts.rateManager;
  const fetchFn  = opts._fetch ?? _httpGet;

  const headers = {
    'User-Agent': USER_AGENT,
    'Accept':     opts.accept,
  };
  if (apiKey) headers['Authorization'] = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');

  let last = null;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    if (rateManager) await rateManager.waitForSlot();

    last = await _executeWithRedirects(url, {
      headers,
      binary:          opts.binary,
      followRedirects: opts.followRedirects,
      connectTimeout:  opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      requestTimeout:  opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      fetchFn,
    });

    if (last.errorType === 'RATE_LIMITED') {
      if (rateManager) rateManager.record429(last.headers);
      if (attempt < maxRetry) continue;
      return last;
    }
    // 5xx / connection errors → one retry; everything else is definitive.
    const transient = last.errorType === 'CONNECTION_ERROR' ||
      (last.httpStatus != null && last.httpStatus >= 500);
    if (transient && attempt < maxRetry) { await _sleep(attempt === 0 ? 1500 : 3000); continue; }
    return last;
  }
  return last;
}

async function _executeWithRedirects(initialUrl, o) {
  let url = initialUrl;
  let opts = o;                       // per-hop options; headers may be narrowed on a cross-origin redirect
  let origin = _originOf(initialUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await opts.fetchFn(url, opts);
    if (r.error) {
      const isConn = CONNECTION_ERROR_CODES.has(r.error.code ?? '');
      return _result('CONNECTION_ERROR', null, url, null, null, null,
        isConn ? (r.error.code ?? 'CONN') : (r.error.message ?? String(r.error)));
    }
    const { statusCode, headers, bodyBuffer } = r;

    if (opts.followRedirects && (statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307) && headers.location) {
      const next = _resolveUrl(headers.location, url);
      const nextOrigin = _originOf(next);
      // Drop Authorization when the redirect crosses to a DIFFERENT origin (e.g. the
      // CH Document API → an S3 presigned URL). The presigned URL already authenticates
      // via its query-string signature; sending Authorization as well makes S3 reject
      // the request with 400 InvalidArgument ("Only one auth mechanism allowed"). This
      // is the standard HTTP-client rule; all OTHER headers are preserved unchanged.
      if (nextOrigin !== origin && opts.headers && opts.headers.Authorization) {
        const { Authorization, ...rest } = opts.headers;
        opts = { ...opts, headers: rest };
      }
      url = next;
      origin = nextOrigin;
      if (hop === MAX_REDIRECTS) return _result('HTTP_ERROR', statusCode, url, headers, null, null, 'too many redirects');
      continue;
    }

    if (statusCode === 200) {
      return o.binary
        ? _result('NONE', 200, url, headers, null, bodyBuffer, null)
        : _result('NONE', 200, url, headers, bodyBuffer.toString('utf8'), null, null);
    }
    if (statusCode === 404) return _result('NOT_FOUND', 404, url, headers, null, null, 'not found');
    if (statusCode === 410) return _result('GONE', 410, url, headers, null, null, 'gone');
    if (statusCode === 429) return _result('RATE_LIMITED', 429, url, headers, null, null, 'rate limited');
    return _result('HTTP_ERROR', statusCode, url, headers, null, null, `HTTP ${statusCode}`);
  }
  return _result('HTTP_ERROR', null, url, null, null, null, 'redirect loop');
}

function _result(errorType, httpStatus, requestUri, headers, bodyText, bodyBuffer, errorMessage) {
  return {
    errorType, httpStatus, requestUri,
    headers: headers ?? null,
    etag: headers ? (headers.etag ?? null) : null,
    bodyText: bodyText ?? null,
    bodyBuffer: bodyBuffer ?? null,
    errorMessage: errorMessage ?? null,
  };
}

// ── Raw HTTP GET ───────────────────────────────────────────────────────────────

function _httpGet(url, o) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { resolve({ error: Object.assign(new Error('bad url'), { code: 'EBADURL' }) }); return; }
    const transport = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  o.headers,
      timeout:  o.connectTimeout,
    };
    const req = transport.request(reqOptions, (res) => {
      const chunks = [];
      const timer = setTimeout(() => req.destroy(new Error('response body timeout')), o.requestTimeout);
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ statusCode: res.statusCode, headers: res.headers, bodyBuffer: Buffer.concat(chunks) });
      });
      res.on('error', err => { clearTimeout(timer); resolve({ error: err }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }) }); });
    req.on('error', err => resolve({ error: err }));
    req.end();
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function _resolveUrl(location, base) {
  try { return new URL(location, base).toString(); } catch { return location; }
}

function _originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function _parseRetryAfter(value) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isNaN(n)) return n;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return Math.max(0, (d.getTime() - Date.now()) / 1000);
  return null;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))); }

module.exports = {
  getJson,
  getBinary,
  createRateManager,
  PDA_HOST, DOC_HOST, STREAM_HOST, USER_AGENT,
  // exported for tests
  _parseRetryAfter, _resolveUrl, _originOf,
};

/**
 * @typedef {Object} RateManager
 * @property {function(): Promise<void>} waitForSlot
 * @property {function(Object): void} record429
 */
/**
 * @typedef {Object} JsonResult
 * @property {'NONE'|'NOT_FOUND'|'GONE'|'RATE_LIMITED'|'HTTP_ERROR'|'CONNECTION_ERROR'|'PARSE_ERROR'} errorType
 * @property {number|null} httpStatus
 * @property {string} requestUri
 * @property {string|null} etag
 * @property {Object|null} body
 * @property {Object|null} headers
 * @property {string|null} errorMessage
 */
/**
 * @typedef {Object} BinaryResult
 * @property {'NONE'|'NOT_FOUND'|'GONE'|'RATE_LIMITED'|'HTTP_ERROR'|'CONNECTION_ERROR'} errorType
 * @property {number|null} httpStatus
 * @property {string} requestUri
 * @property {string|null} contentType
 * @property {Buffer|null} bytes
 * @property {Object|null} headers
 * @property {string|null} errorMessage
 */
