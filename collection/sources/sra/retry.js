'use strict';

// retry.js — transient-failure retry with bounded attempts + exponential backoff.
//
// SRA Snapshot Collector v0.1.
//
// Pure operational concern: it re-attempts a request thunk on TRANSIENT failures
// only, records EVERY attempt, and stops on success / permanent failure / the
// bounded attempt cap. It alters no data.
//
// classifyOutcome/backoffMs/DEFAULT_POLICY are shared with FCA — extracted to
// ../common/retry (WS2 Phase P7, WP-15), replacing the prior verbatim copy.
// withRetry stays here: this source's attempt log omits the FCA-specific
// `fsrStatus` field. Companies House uses a different retry-after-aware
// policy (collection/sources/companies-house/ch-client.js) and is not part
// of this consolidation.

const { classifyOutcome, backoffMs, DEFAULT_POLICY } = require('../common/retry');

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
      errorMessage: last ? last.errorMessage : null,
      at: now(),
    });
    if (outcome !== 'transient') break;       // success or permanent → stop
    if (n < pol.maxAttempts) await sleep(backoffMs(n, pol)); // bounded backoff before next try
  }
  return { attempts, final: last };
}

module.exports = { withRetry, classifyOutcome, backoffMs, DEFAULT_POLICY };
