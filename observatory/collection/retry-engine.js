'use strict';

// retry-engine.js — production-hardening (Blocker 2). A signal-agnostic retry
// wrapper with failure classification and exponential backoff.
//
// It retries ONLY failures the classifier marks RETRYABLE (transient DNS/TLS/
// HTTP/network conditions and rate limiting). PERMANENT failures (NXDOMAIN,
// malformed domain, unsupported protocol) and UNEXPECTED failures (collector
// bugs, infrastructure faults) stop immediately — retrying them wastes the
// collection window and, for bugs, hides the defect.
//
// EVIDENCE INTEGRITY: this module produces retry *metadata* (attempt counts, the
// per-attempt classification history) and returns it to the caller. It never
// touches an Observation, a Collection Session, or the Event log. The caller
// persists retry metadata onto the operational progress ledger — never onto
// immutable evidence.
//
// Everything is injectable (sleep, rng, classify, clock) so behaviour is fully
// deterministic under test with no real timers and no real randomness.

const { classifyFailure } = require('./failure-classifier');

// Defaults are read from the environment once, at call time, so operators can
// tune retry behaviour without code changes (Blocker 2: "Retry attempts should
// be configurable").
function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const DEFAULTS = Object.freeze({
  maxAttempts: () => envInt('COLLECTION_RETRY_MAX_ATTEMPTS', 3), // total attempts incl. the first
  baseDelayMs: () => envInt('COLLECTION_RETRY_BASE_DELAY_MS', 500),
  maxDelayMs: () => envInt('COLLECTION_RETRY_MAX_DELAY_MS', 30000),
  factor: () => envInt('COLLECTION_RETRY_FACTOR', 2),
  jitter: () => String(process.env.COLLECTION_RETRY_JITTER ?? 'true') !== 'false',
});

// computeBackoff(attempt, opts) — the delay (ms) to wait AFTER a failed `attempt`
// (1-indexed) before the next one. Exponential: base * factor^(attempt-1),
// clamped to maxDelayMs. With `jitter`, applies full jitter (uniform in
// [0, delay]) to avoid thundering-herd re-collection at national scale.
function computeBackoff(attempt, opts = {}) {
  const base = opts.baseDelayMs ?? DEFAULTS.baseDelayMs();
  const max = opts.maxDelayMs ?? DEFAULTS.maxDelayMs();
  const factor = opts.factor ?? DEFAULTS.factor();
  const raw = base * Math.pow(factor, Math.max(0, attempt - 1));
  const capped = Math.min(max, raw);
  const jitter = opts.jitter ?? DEFAULTS.jitter();
  if (!jitter) return Math.round(capped);
  const rng = opts.rng ?? Math.random;
  return Math.round(capped * rng());
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// withRetry(fn, opts) — run `fn` (an async collector call), retrying transient
// failures with exponential backoff.
//
// `fn` is called as fn({ attempt }) so a collector can log its own attempt if it
// wants. Returns a settled result object — it NEVER throws, so a caller in a
// concurrency pool always gets a structured outcome:
//
//   { ok: true,  value, attempts, classification: null, history }
//   { ok: false, error, attempts, classification, history }
//
//   history: [{ attempt, class, reason, retried, delayMs }]
//
// opts: { maxAttempts, baseDelayMs, maxDelayMs, factor, jitter, rng,
//         classify, sleep, onRetry, retryUnexpected }
async function withRetry(fn, opts = {}) {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULTS.maxAttempts());
  const classify = opts.classify ?? classifyFailure;
  const sleep = opts.sleep ?? defaultSleep;
  const retryUnexpected = opts.retryUnexpected ?? false;
  const history = [];

  let attempt = 0;
  let lastClassification = null;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const value = await fn({ attempt });
      return { ok: true, value, attempts: attempt, classification: null, history };
    } catch (rawErr) {
      const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
      lastError = err;
      const classification = classify(err);
      lastClassification = classification;

      const isLast = attempt >= maxAttempts;
      const eligible = classification.class === 'RETRYABLE'
        || (retryUnexpected && classification.class === 'UNEXPECTED');
      const willRetry = eligible && !isLast;

      const delayMs = willRetry ? computeBackoff(attempt, opts) : 0;
      history.push({
        attempt,
        class: classification.class,
        reason: classification.reason,
        code: classification.code,
        retried: willRetry,
        delayMs,
        error: err.message,
      });

      if (!willRetry) {
        return { ok: false, error: err, attempts: attempt, classification, history };
      }

      if (typeof opts.onRetry === 'function') {
        try { await opts.onRetry({ attempt, delayMs, classification, error: err }); } catch { /* logging hook never breaks retry */ }
      }
      await sleep(delayMs);
    }
  }

  // Unreachable in practice (the loop returns on every path), but keeps the
  // function total.
  return { ok: false, error: lastError, attempts: attempt, classification: lastClassification, history };
}

module.exports = { withRetry, computeBackoff, DEFAULTS };
