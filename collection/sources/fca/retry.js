'use strict';

// retry.js — transient-failure retry with bounded attempts + exponential backoff.
//
// Reference Collector v0.1 — PHASE 7 (IMP-FCA-001 §7; CCS-FCA-001 §11).
//
// Pure operational concern: it re-attempts a request thunk on TRANSIENT failures
// only, records EVERY attempt, and stops on success / permanent failure / the
// bounded attempt cap. It alters no evidence — the caller preserves the final
// observation plus the per-attempt log. A retry is a fresh observation, never an
// overwrite [CR-FCA-09].
//
// Transient (retried):   CONNECTION_ERROR, RATE_LIMITED (429), HTTP_ERROR >= 500.
// Permanent (not retried): PARSE_ERROR, HTTP_ERROR < 500 (e.g. 404), anything else.
// Success:                 errorType === 'NONE' (the FSR envelope is interpreted
//                          later — an FCA "absence" is still a successful transport
//                          outcome and is NOT retried).
//
// Authority: CCS-FCA-001 §11; CCD-FCA-001 CR-FCA-09; IMP-FCA-001 §7.

const DEFAULT_POLICY = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 };

function classifyOutcome(result) {
  if (!result) return 'permanent';
  const et = result.errorType;
  if (et === 'NONE') return 'success';
  if (et === 'CONNECTION_ERROR' || et === 'RATE_LIMITED') return 'transient';
  if (et === 'HTTP_ERROR' && typeof result.httpStatus === 'number' && result.httpStatus >= 500) return 'transient';
  return 'permanent';
}

function backoffMs(attemptNumber, policy) {
  const d = policy.baseDelayMs * Math.pow(2, attemptNumber - 1);
  return Math.min(d, policy.maxDelayMs);
}

/**
 * Run `thunk(attemptNumber) -> Promise<result>` with retry. Never throws.
 *
 * @returns {{ attempts: Object[], final: Object }} every attempt's outcome log + the final result
 */
async function withRetry(thunk, policy = {}, helpers = {}) {
  const pol = { ...DEFAULT_POLICY, ...policy };
  const sleep = helpers._sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = helpers._now ?? (() => new Date().toISOString());

  const attempts = [];
  let last = null;
  for (let n = 1; n <= pol.maxAttempts; n++) {
    last = await thunk(n);
    const outcome = classifyOutcome(last);
    attempts.push({
      attemptNumber: n,
      outcome,
      transport: last ? last.errorType : null,
      httpStatus: last ? last.httpStatus : null,
      fsrStatus: last ? last.fsrStatus : null,
      errorMessage: last ? last.errorMessage : null,
      at: now(),
    });
    if (outcome !== 'transient') break;     // success or permanent → stop
    if (n < pol.maxAttempts) await sleep(backoffMs(n, pol)); // bounded backoff before next try
  }
  return { attempts, final: last };
}

module.exports = { withRetry, classifyOutcome, backoffMs, DEFAULT_POLICY };
