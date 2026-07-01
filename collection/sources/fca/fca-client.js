'use strict';

// fca-client.js — FCA Financial Services Register API HTTP client (transport only).
//
// Reference Collector v0.1 — PHASE 1 ONLY (IMP-FCA-001 §1).
//
// This module is PURE TRANSPORT + configuration. It executes a single
// authenticated GET against the FS Register API (ESD-FCA-001 §4.1), returns the
// raw result and the parsed FCA envelope, and assigns NO meaning. It does not
// observe, preserve, extract, paginate, retry, classify outcomes, or follow
// cross-entity links — those are later phases (IMP-FCA-001 §3–§8). It never
// throws: every transport outcome is a structured result.
//
// Constitutional conformance (Phase 1 surface):
//   - Auth is header-based: X-Auth-Email + X-Auth-Key (ESD-FCA-001 §4.1). The
//     credential authenticates the *observer application*, not access to the
//     target — the zero-access principle holds. The credential is consumed to
//     build request headers and is NEVER returned in any result structure
//     [CR-FCA-07].
//   - The raw body is retained even when JSON parsing fails (CCS-FCA-001 §6,
//     §10) [CR-FCA-03].
//   - The HTTP status and the FCA `Status` envelope are surfaced SEPARATELY; the
//     client never collapses the outcome to the HTTP status (CCS-FCA-001 §9)
//     [CR-FCA-05]. (Classification of observed-absence vs non-observation is a
//     later phase; Phase 1 only surfaces both, uninterpreted.)
//
// Authority: CCS-FCA-001 §2, §3, §6, §9; CCD-FCA-001 CR-FCA-05/07/08;
//   ESD-FCA-001 §4; IMP-FCA-001 §1.

const https = require('node:https');
const http = require('node:http');

const USER_AGENT = 'Soterius-SignalLab/1.0 (source:fca; spec:CCS-FCA-001)';
const DEFAULT_BASE_URL = 'https://register.fca.org.uk/services/V0.1';
const API_VERSION = 'V0.1';
const REGISTER_HOST = 'register.fca.org.uk';

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ECONNABORTED', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'EBADURL',
]);

// ── Configuration ────────────────────────────────────────────────────────────────

/**
 * Load collector configuration from the environment (CCS-FCA-001 §2; IMP §1).
 * Reads the FCA credentials already configured for the project (backend/.env:
 * FCA_EMAIL, FCA_API_KEY). Does NOT read or cache anything else; pure.
 *
 * @param {Object} [env=process.env]
 * @returns {{ email: string|null, apiKey: string|null, baseUrl: string, apiVersion: string }}
 */
function loadConfig(env = process.env) {
  return {
    email: env.FCA_EMAIL ?? null,
    apiKey: env.FCA_API_KEY ?? null,
    baseUrl: env.FCA_BASE_URL ?? DEFAULT_BASE_URL,
    apiVersion: API_VERSION,
  };
}

/**
 * Validate configuration BEFORE any API request (CCS-FCA-001 §3 preconditions).
 * Surfaces problems clearly but does not interpret them; returns a structured
 * result rather than throwing (the caller decides what to do).
 *
 * @param {Object} config
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { ok: false, errors: ['configuration object missing'] };
  }
  if (!config.email) errors.push('FCA_EMAIL is not set');
  if (!config.apiKey) errors.push('FCA_API_KEY is not set');
  if (!config.baseUrl) {
    errors.push('baseUrl is not set');
  } else {
    try { new URL(config.baseUrl); } catch { errors.push('baseUrl is not a valid URL'); }
  }
  return { ok: errors.length === 0, errors };
}

/** Join a base URL and a path suffix into an absolute URL. Pure string helper. */
function buildUrl(baseUrl, pathSuffix) {
  const b = String(baseUrl).replace(/\/+$/, '');
  const p = String(pathSuffix).startsWith('/') ? String(pathSuffix) : '/' + String(pathSuffix);
  return b + p;
}

// ── JSON GET ───────────────────────────────────────────────────────────────────

/**
 * GET a JSON resource from the FS Register. Never rejects.
 *
 * Returns both the transport outcome and the FCA envelope, unconflated. The raw
 * body text is always retained when received (even on a JSON parse failure).
 *
 * @param {string} url - absolute URL
 * @param {Object} opts
 * @param {string} opts.email  - X-Auth-Email (consumed; never returned)
 * @param {string} opts.apiKey - X-Auth-Key  (consumed; never returned)
 * @param {function} [opts._fetch] - injectable transport for tests
 * @param {number} [opts.connectTimeoutMs]
 * @param {number} [opts.requestTimeoutMs]
 * @returns {Promise<JsonResult>}
 */
async function getJson(url, opts = {}) {
  const res = await _request(url, { ...opts, accept: 'application/json' });

  let body = null;
  let parseError = null;
  if (res.errorType === 'NONE' && res.bodyText != null && res.bodyText.length > 0) {
    try { body = JSON.parse(res.bodyText); }
    catch (e) { parseError = e.message; }
  }

  // The FCA envelope (EOI-FCA-001 §8) lives at the top level of every payload.
  const envelope = (body && typeof body === 'object' && !Array.isArray(body))
    ? { status: body.Status ?? null, message: body.Message ?? null, resultInfo: body.ResultInfo ?? null }
    : null;

  return {
    errorType: parseError ? 'PARSE_ERROR' : res.errorType,
    httpStatus: res.httpStatus,
    requestUri: res.requestUri,
    headers: res.headers,            // RESPONSE headers only (no request headers → no credential)
    rawBody: res.bodyText ?? null,   // retained verbatim, even on parse error [CR-FCA-03]
    body,                            // parsed JSON | null
    envelope,                        // { status, message, resultInfo } | null
    fsrStatus: envelope ? envelope.status : null, // convenience: the FSR-API code [CR-FCA-05]
    errorMessage: parseError ?? res.errorMessage,
  };
}

// ── Request execution (auth + transport classification) ──────────────────────────

async function _request(url, opts) {
  const fetchFn = opts._fetch ?? _httpGet;

  const headers = { 'User-Agent': USER_AGENT, 'Accept': opts.accept };
  if (opts.email) headers['X-Auth-Email'] = opts.email;
  if (opts.apiKey) headers['X-Auth-Key'] = opts.apiKey;

  const r = await fetchFn(url, {
    headers,
    connectTimeout: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeout: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });

  if (r.error) {
    const isConn = CONNECTION_ERROR_CODES.has(r.error.code ?? '');
    return _result('CONNECTION_ERROR', null, url, null, null,
      isConn ? (r.error.code ?? 'CONN') : (r.error.message ?? String(r.error)));
  }

  const { statusCode, headers: resHeaders, bodyBuffer } = r;
  const bodyText = bodyBuffer != null ? bodyBuffer.toString('utf8') : null;

  // Transport-level classification ONLY. The FCA returns HTTP 200 for success,
  // empty, AND not-found (the real outcome is the FSR `Status` code, surfaced by
  // getJson). A 2xx is therefore "transport OK"; meaning is NOT decided here.
  if (statusCode >= 200 && statusCode < 300) return _result('NONE', statusCode, url, resHeaders, bodyText, null);
  if (statusCode === 429) return _result('RATE_LIMITED', 429, url, resHeaders, bodyText, 'rate limited');
  return _result('HTTP_ERROR', statusCode, url, resHeaders, bodyText, `HTTP ${statusCode}`);
}

function _result(errorType, httpStatus, requestUri, headers, bodyText, errorMessage) {
  return {
    errorType,
    httpStatus,
    requestUri,
    headers: headers ?? null,
    bodyText: bodyText ?? null,
    errorMessage: errorMessage ?? null,
  };
}

// ── Raw HTTP GET ─────────────────────────────────────────────────────────────────

function _httpGet(url, o) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { resolve({ error: Object.assign(new Error('bad url'), { code: 'EBADURL' }) }); return; }

    const transport = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: o.headers,
      timeout: o.connectTimeout,
    };

    const req = transport.request(reqOptions, (res) => {
      const chunks = [];
      const timer = setTimeout(() => req.destroy(new Error('response body timeout')), o.requestTimeout);
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ statusCode: res.statusCode, headers: res.headers, bodyBuffer: Buffer.concat(chunks) });
      });
      res.on('error', (err) => { clearTimeout(timer); resolve({ error: err }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }) }); });
    req.on('error', (err) => resolve({ error: err }));
    req.end();
  });
}

module.exports = {
  loadConfig,
  validateConfig,
  buildUrl,
  getJson,
  USER_AGENT,
  DEFAULT_BASE_URL,
  API_VERSION,
  REGISTER_HOST,
};

/**
 * @typedef {Object} JsonResult
 * @property {'NONE'|'RATE_LIMITED'|'HTTP_ERROR'|'CONNECTION_ERROR'|'PARSE_ERROR'} errorType
 * @property {number|null} httpStatus
 * @property {string} requestUri
 * @property {Object|null} headers
 * @property {string|null} rawBody
 * @property {Object|null} body
 * @property {{status: string|null, message: string|null, resultInfo: Object|null}|null} envelope
 * @property {string|null} fsrStatus
 * @property {string|null} errorMessage
 */
