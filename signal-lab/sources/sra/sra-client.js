'use strict';

// sra-client.js — SRA Firm Data Web Service HTTP client (transport only).
//
// SRA Snapshot Collector v0.1 — Observe layer.
//
// This module is PURE TRANSPORT + configuration. It loads/validates configuration,
// authenticates with the SRA subscription key, executes a single GET against the
// Firm Data Web Service, classifies the transport outcome, and returns the raw
// result. It assigns NO meaning: it does not preserve, parse into structured
// evidence, paginate, retry, or follow links (those are other modules). It NEVER
// throws — every transport outcome is a structured result.
//
// Authentication. The SRA web service is an Azure API Management surface; the
// subscription key authenticates the re-user application (zero-access principle
// holds). It is consumed to build request headers and is NEVER returned in any
// result structure. The header name follows the Azure APIM convention
// (Ocp-Apim-Subscription-Key) — CONFIRM against the SRA Technical Document.
//
// Discovery facts (from public SRA documentation):
//   - Free JSON web service, refreshed every 24h, exposes a production timestamp.
//   - Subscription key required on every request; per-24h rate cap (number TBD).
//   - Base URL / exact endpoint path are registration-gated → CONFIRM in the
//     Technical Document; both are configurable via env (SRA_BASE_URL).
//
// Authority: SRA Snapshot Collector design §"New SRA-specific modules: sra-client".

const https = require('node:https');
const http = require('node:http');

const USER_AGENT = 'Soterius-SignalLab/1.0 (source:sra)';
// Azure APIM gateway host (portal is *.developer.azure-api.net; gateway is
// *.azure-api.net). PLACEHOLDER default — CONFIRM exact gateway + path in the
// SRA Technical Document; override with SRA_BASE_URL.
const DEFAULT_BASE_URL = 'https://sra-prod-apim.azure-api.net';
const SUBSCRIPTION_KEY_HEADER = 'Ocp-Apim-Subscription-Key';

const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60000; // a bulk snapshot segment can be large

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ECONNABORTED', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'EBADURL',
]);

// ── Configuration ──────────────────────────────────────────────────────────────

/**
 * Load collector configuration from the environment. Pure; reads nothing else.
 *
 * @param {Object} [env=process.env]
 * @returns {{ subscriptionKey: string|null, baseUrl: string }}
 */
function loadConfig(env = process.env) {
  return {
    subscriptionKey: env.SRA_SUBSCRIPTION_KEY ?? null,
    baseUrl: env.SRA_BASE_URL ?? DEFAULT_BASE_URL,
  };
}

/**
 * Validate configuration BEFORE any request. Returns a structured result; never throws.
 *
 * @param {Object} config
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return { ok: false, errors: ['configuration object missing'] };
  if (!config.subscriptionKey) errors.push('SRA_SUBSCRIPTION_KEY is not set');
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

// ── GET (raw; no evidence parsing) ───────────────────────────────────────────────

/**
 * GET a resource from the SRA web service. Never rejects. Returns the transport
 * outcome and the RAW body string verbatim (no JSON parsing into evidence).
 *
 * @param {string} url - absolute URL
 * @param {Object} opts
 * @param {string}   opts.subscriptionKey - consumed into the auth header; NEVER returned
 * @param {function} [opts._fetch]         - injectable transport for tests
 * @param {number}   [opts.connectTimeoutMs]
 * @param {number}   [opts.requestTimeoutMs]
 * @param {string}   [opts.accept='application/json']
 * @returns {Promise<TransportResult>}
 */
async function get(url, opts = {}) {
  const fetchFn = opts._fetch ?? _httpGet;

  const headers = { 'User-Agent': USER_AGENT, 'Accept': opts.accept ?? 'application/json' };
  if (opts.subscriptionKey) headers[SUBSCRIPTION_KEY_HEADER] = opts.subscriptionKey;

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
  const rawBody = bodyBuffer != null ? bodyBuffer.toString('utf8') : null;

  // Transport-level classification ONLY. No body interpretation here.
  if (statusCode >= 200 && statusCode < 300) return _result('NONE', statusCode, url, resHeaders, rawBody, null);
  if (statusCode === 429) return _result('RATE_LIMITED', 429, url, resHeaders, rawBody, 'rate limited');
  return _result('HTTP_ERROR', statusCode, url, resHeaders, rawBody, `HTTP ${statusCode}`);
}

function _result(errorType, httpStatus, requestUri, headers, rawBody, errorMessage) {
  return {
    errorType,
    httpStatus,
    requestUri,
    headers: headers ?? null,        // RESPONSE headers only (no request headers → no credential)
    rawBody: rawBody ?? null,        // verbatim body string; retained even on HTTP error
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
  get,
  USER_AGENT,
  DEFAULT_BASE_URL,
  SUBSCRIPTION_KEY_HEADER,
};

/**
 * @typedef {Object} TransportResult
 * @property {'NONE'|'RATE_LIMITED'|'HTTP_ERROR'|'CONNECTION_ERROR'} errorType
 * @property {number|null} httpStatus
 * @property {string} requestUri
 * @property {Object|null} headers   - response headers only
 * @property {string|null} rawBody   - verbatim body string
 * @property {string|null} errorMessage
 */
