'use strict';

// web-fetch — a never-throwing HTTP GET tool for the Research Agent's
// source-acquisition step (execution architecture design, §E "Visit
// Website"). No browser automation: a plain HTTP client only.
//
// Every expected failure (timeout, connection error, HTTP error, blocked
// SSRF target, oversized response) is returned as a structured result, never
// thrown — callers (research-website.js) decide what a failure means for
// the investigation, this module only reports what happened.

const axios = require('axios');
const urlPolicy = require('./url-policy');

const DEFAULT_TIMEOUT_MS = 20000; // within the required 15-30s window
const DEFAULT_MAX_CONTENT_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_RETRY_DELAY_MS = 250;
const USER_AGENT = 'SoteriusCommercialObservatoryBot/1.0 (+internal research; https://soterius.com)';

const RETRYABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);

function delay(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Default HTTP transport: axios, adapted to the small shape this module needs. */
async function defaultHttpClient(url, config) {
  const response = await axios.get(url, { ...config, validateStatus: () => true });
  const finalUrl = response.request?.res?.responseUrl || url;
  return { status: response.status, data: response.data, headers: response.headers, finalUrl };
}

function classifyThrownError(err) {
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) return 'timeout';
  if (RETRYABLE_ERROR_CODES.has(err.code)) return 'connection_error';
  return 'unknown_error';
}

function failure({ requestedUrl, finalUrl = null, status = null, errorType, error, retryable }) {
  return { success: false, requestedUrl, finalUrl, status, errorType, error, retryable };
}

/**
 * fetchUrl(url, options) -> Promise<Result>
 *
 * options: { timeoutMs, maxRedirects, maxContentBytes, userAgent, maxRetries,
 *   retryDelayMs, httpClient, resolveHostnameSafely }
 * — every dependency is injectable so tests never touch the network or DNS.
 */
async function fetchUrl(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxContentBytes = DEFAULT_MAX_CONTENT_BYTES,
    userAgent = USER_AGENT,
    maxRetries = 1,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    httpClient = defaultHttpClient,
    resolveHostnameSafely = urlPolicy.resolveHostnameSafely,
  } = options;

  const requestedUrl = url;

  if (!urlPolicy.isAllowedProtocol(url)) {
    return failure({ requestedUrl, errorType: 'unsupported_protocol', error: `Unsupported protocol for ${url}`, retryable: false });
  }
  if (urlPolicy.exceedsMaxUrlLength(url)) {
    return failure({ requestedUrl, errorType: 'url_too_long', error: 'URL exceeds maximum allowed length', retryable: false });
  }

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return failure({ requestedUrl, errorType: 'invalid_url', error: `Could not parse URL: ${url}`, retryable: false });
  }

  const safety = await resolveHostnameSafely(hostname);
  if (!safety.safe) {
    return failure({ requestedUrl, errorType: 'ssrf_blocked', error: `Blocked unsafe destination (${safety.reason})`, retryable: false });
  }

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await httpClient(url, {
        timeout: timeoutMs,
        maxRedirects,
        maxContentLength: maxContentBytes,
        maxBodyLength: maxContentBytes,
        headers: { 'User-Agent': userAgent },
      });

      if (response.status >= 500) {
        if (attempt < maxRetries) { await delay(retryDelayMs); continue; }
        return failure({ requestedUrl, finalUrl: response.finalUrl, status: response.status, errorType: 'server_error', error: `HTTP ${response.status}`, retryable: true });
      }
      if (response.status >= 400) {
        return failure({ requestedUrl, finalUrl: response.finalUrl, status: response.status, errorType: 'http_error', error: `HTTP ${response.status}`, retryable: false });
      }

      const body = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      if (Buffer.byteLength(body, 'utf8') > maxContentBytes) {
        return failure({ requestedUrl, finalUrl: response.finalUrl, status: response.status, errorType: 'response_too_large', error: 'Response body exceeded maximum size', retryable: false });
      }

      return {
        success: true,
        requestedUrl,
        finalUrl: response.finalUrl || requestedUrl,
        status: response.status,
        contentType: response.headers?.['content-type'] || null,
        body,
        retrievedAt: new Date().toISOString(),
        headers: response.headers || {},
      };
    } catch (err) {
      const errorType = classifyThrownError(err);
      const retryable = errorType === 'timeout' || errorType === 'connection_error';
      if (retryable && attempt < maxRetries) { await delay(retryDelayMs); continue; }
      return failure({ requestedUrl, errorType, error: err.message, retryable });
    }
  }

  // Unreachable in practice (the loop always returns), kept as an honest fallback.
  return failure({ requestedUrl, errorType: 'unknown_error', error: 'Exhausted retries without a result', retryable: false });
}

module.exports = { fetchUrl, USER_AGENT, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_CONTENT_BYTES };
