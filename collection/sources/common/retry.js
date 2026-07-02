'use strict';

// retry.js (common) — transient-failure classification + backoff scheduling,
// shared by the FCA and SRA source collectors.
//
// Extracted under ADR-COL-006 (sources/common/ consolidation authorised) /
// WS2 Phase P7 (WP-15). Verified byte-identical in both source-specific
// retry.js files prior to extraction — classifyOutcome and backoffMs took
// no source-specific inputs and produced no source-specific output.
//
// withRetry() itself is NOT extracted here: FCA's attempt log records an
// additional `fsrStatus` field that SRA's does not, and Companies House uses
// an entirely different retry-after-aware policy (collection/sources/companies-house/ch-client.js) —
// none of the three sources' request-loop wiring is safe to unify without
// weakening source-specific behaviour, so each source keeps its own
// `withRetry` built on these shared primitives.
//
// Transient (retried):   CONNECTION_ERROR, RATE_LIMITED (429), HTTP_ERROR >= 500.
// Permanent (not retried): HTTP_ERROR < 500, anything else.
// Success:                 errorType === 'NONE'.

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

module.exports = { classifyOutcome, backoffMs, DEFAULT_POLICY };
