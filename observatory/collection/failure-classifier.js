'use strict';

// failure-classifier.js — production-hardening (Sprint: Observatory production
// readiness, Blocker 2). Classifies a collection failure into one of three
// operational classes so the retry engine knows whether a failure is worth
// retrying, and so the run lifecycle can report failures truthfully.
//
//   RETRYABLE  — transient network/DNS/HTTP conditions that commonly succeed on
//                a later attempt (DNS timeout, temporary TLS failure, HTTP
//                timeout, connection reset, transient resolver failure, rate
//                limiting). SAFE to retry with backoff.
//   PERMANENT  — a definite, stable answer that no retry will change (NXDOMAIN,
//                malformed domain, unsupported protocol, permanently invalid
//                configuration / 4xx client error). NEVER retried.
//   UNEXPECTED — collector exceptions, infrastructure failures, and programming
//                errors (TypeError/ReferenceError/…). NOT retried by default —
//                these are surfaced loudly rather than masked by retries, because
//                a bug does not become correct by being run again.
//
// This module is PURE and signal-agnostic: it inspects only the shape of the
// error (code / message / HTTP status). It writes nothing and knows nothing about
// Observations, Runs, or the Repository Authority. Classification is advisory
// metadata about a failure; it never mutates evidence.

const CLASS = Object.freeze({
  RETRYABLE: 'RETRYABLE',
  PERMANENT: 'PERMANENT',
  UNEXPECTED: 'UNEXPECTED',
});

// Programming-error constructors — a thrown TypeError/ReferenceError/… is a bug
// in collector code, not a fact about the domain. Always UNEXPECTED.
const PROGRAMMING_ERROR_NAMES = new Set([
  'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError',
]);

// Transient network / DNS / socket codes. A connection that reset, a resolver
// that timed out, a temporarily-unreachable host — all worth another attempt.
const RETRYABLE_CODES = new Set([
  // DNS (transient)
  'DNS_TIMEOUT', 'ETIMEOUT', 'ETIMEDOUT', 'EAI_AGAIN', 'ESERVFAIL', 'EREFUSED', 'ETRYAGAIN',
  // Socket / network (transient)
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENETDOWN', 'ENETRESET', 'ECANCELED', 'ECANCELLED', 'EAGAIN', 'EBUSY',
  // TLS (temporary handshake failures — spec: "temporary TLS failure")
  'EPROTO',
]);

// Definite, stable failures. NXDOMAIN and friends will not change on retry; a
// malformed domain or unsupported protocol is a permanent input error.
const PERMANENT_CODES = new Set([
  // DNS — the name definitively does not exist / has no such record
  'ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'EBADNAME',
  // URL / protocol
  'ERR_INVALID_URL', 'ERR_INVALID_PROTOCOL', 'ERR_UNSUPPORTED_PROTOCOL', 'ERR_INVALID_ARG_VALUE',
]);

// Message fragments (lower-cased substring match) used only when a structured
// code is absent — many collectors throw plain Errors with descriptive text.
const RETRYABLE_MESSAGES = [
  'timeout', 'timed out', 'socket hang up', 'connection reset', 'econnreset',
  'network', 'temporarily unavailable', 'temporary failure', 'try again',
  'rate limit', 'too many requests', 'handshake', 'eai_again', 'servfail',
];

const PERMANENT_MESSAGES = [
  'nxdomain', 'not found', 'malformed', 'invalid domain', 'invalid hostname',
  'unsupported protocol', 'protocol not supported', 'no such host',
];

// HTTP status → class. 429 and 5xx are transient; 408 (request timeout) is
// transient; other 4xx are permanent client/config errors.
function classifyHttpStatus(status) {
  if (status === 429 || status === 408) return CLASS.RETRYABLE;
  if (status >= 500) return CLASS.RETRYABLE;
  if (status >= 400) return CLASS.PERMANENT;
  return null;
}

function extractStatus(err) {
  if (!err || typeof err !== 'object') return null;
  const s = err.status ?? err.statusCode ?? (err.response && err.response.status);
  return Number.isInteger(s) ? s : null;
}

function matchesAny(haystack, fragments) {
  return fragments.some((f) => haystack.includes(f));
}

// classifyFailure(err) → { class, reason, code, status, retryable }
//
// Precedence is deliberate: definite permanents (NXDOMAIN etc.) beat the broad
// transient message matcher, and programming-error constructors beat everything
// (a bug is never a domain fact). Anything unrecognised is UNEXPECTED, not
// silently retried.
function classifyFailure(err) {
  const code = (err && (err.code || err.errno)) ? String(err.code || err.errno).toUpperCase() : null;
  const name = err && err.name ? String(err.name) : null;
  const message = err && (err.message || typeof err === 'string') ? String(err.message || err) : '';
  const lower = message.toLowerCase();
  const status = extractStatus(err);

  const make = (klass, reason) => ({
    class: klass,
    reason,
    code: code || null,
    status: status ?? null,
    retryable: klass === CLASS.RETRYABLE,
  });

  // 1. Programming errors are always UNEXPECTED — never retried, always surfaced.
  if (name && PROGRAMMING_ERROR_NAMES.has(name)) {
    return make(CLASS.UNEXPECTED, `programming error (${name})`);
  }

  // 2. Definite permanent codes (NXDOMAIN, malformed, unsupported protocol).
  if (code && PERMANENT_CODES.has(code)) {
    return make(CLASS.PERMANENT, `permanent code ${code}`);
  }

  // 3. Transient network/DNS/TLS codes.
  if (code && RETRYABLE_CODES.has(code)) {
    return make(CLASS.RETRYABLE, `transient code ${code}`);
  }

  // 4. HTTP status.
  const byStatus = status != null ? classifyHttpStatus(status) : null;
  if (byStatus) return make(byStatus, `http ${status}`);

  // 5. Message heuristics (only when no structured code decided it). Permanent
  //    fragments win over transient ones (e.g. "no such host" must not match the
  //    transient "host" family).
  if (message) {
    if (matchesAny(lower, PERMANENT_MESSAGES)) return make(CLASS.PERMANENT, 'permanent message match');
    if (matchesAny(lower, RETRYABLE_MESSAGES)) return make(CLASS.RETRYABLE, 'transient message match');
  }

  // 6. Unrecognised — a collector exception / infrastructure failure we cannot
  //    positively classify. UNEXPECTED so it is escalated, not masked by retries.
  return make(CLASS.UNEXPECTED, code ? `unrecognised code ${code}` : 'unrecognised failure');
}

function isRetryable(classification) {
  return Boolean(classification) && classification.class === CLASS.RETRYABLE;
}

module.exports = {
  CLASS,
  classifyFailure,
  isRetryable,
  classifyHttpStatus,
  // exported for testing / configuration transparency
  RETRYABLE_CODES,
  PERMANENT_CODES,
};
