'use strict';

// run-lifecycle.js — production-hardening (Blocker 3): failure-aware Collection
// Run lifecycle.
//
// The registry (registry.js) owns the persisted state machine — the legal states
// and transitions, and the optimistic-guarded transitionRun. This module adds the
// pure DERIVATION logic on top: given the truthful per-organisation outcome of a
// run, which terminal state is honest, and what does its completion summary
// (coverage %, organisation counts, failure breakdown) look like.
//
// The point of the sprint is TRUTHFUL status. A run is only COMPLETED if every
// intended organisation was actually collected; if some remained failed after
// retries it is PARTIAL, not COMPLETED. This module encodes exactly that rule so
// no runner can quietly mark a half-finished national collection "COMPLETED".
//
// Pure and DB-free — the executor calls deriveTerminalState/buildCompletionSummary
// and hands the result to registry.transitionRun.

const { RUN_STATUSES, RUN_TRANSITIONS, RUN_TERMINAL_STATUSES, isValidRunTransition, isTerminalRunStatus } = require('./registry');

// The canonical failure-aware lifecycle the sprint specifies. (RUN_STATUSES in
// the registry is the wider union that also carries the legacy PENDING/ABANDONED
// aliases for backward compatibility.)
const LIFECYCLE_STATES = Object.freeze([
  'CREATED', 'QUEUED', 'RUNNING', 'PARTIAL', 'FAILED', 'COMPLETED', 'CANCELLED',
]);

// coveragePct(succeeded, intended) — fraction of intended organisations that
// produced a successful Observation, as a 0–100 number rounded to 2 dp. An empty
// intended set is 0% (there was nothing to cover — never reported as 100%).
function coveragePct(succeeded, intended) {
  if (!intended || intended <= 0) return 0;
  return Math.round((succeeded / intended) * 10000) / 100;
}

// deriveTerminalState({ intended, succeeded, failed, cancelled, aborted }) — the
// single source of truth for how a run finishes.
//
//   CANCELLED — intentionally stopped (cancelled flag). Takes precedence: a
//               cancelled run is cancelled regardless of partial progress.
//   FAILED    — execution could not continue (aborted flag), OR nothing at all
//               was collected (succeeded === 0 with work intended). A run that
//               observed zero organisations is not a success of any kind.
//   COMPLETED — every intended organisation was collected (succeeded === intended
//               and no outstanding failures).
//   PARTIAL   — execution finished but some organisations remain failed after
//               retries (the honest middle state).
function deriveTerminalState({ intended = 0, succeeded = 0, failed = 0, cancelled = false, aborted = false } = {}) {
  if (cancelled) return 'CANCELLED';
  if (aborted) return 'FAILED';
  if (intended <= 0) return 'COMPLETED'; // nothing to do — vacuously complete
  if (succeeded <= 0) return 'FAILED';   // collected nothing despite intending to
  if (succeeded >= intended && failed <= 0) return 'COMPLETED';
  return 'PARTIAL';
}

// buildCompletionSummary — the structured report attached to a finished run:
// truthful terminal state, coverage %, organisation counts, and a failure
// breakdown by class. `byFailureClass` is an object like
// { RETRYABLE: 3, PERMANENT: 12, UNEXPECTED: 1 } tallying WHY organisations
// failed (from the classifier), so an operator can tell "12 domains genuinely do
// not exist" from "3 transient failures we could re-run".
function buildCompletionSummary({
  intended = 0,
  succeeded = 0,
  failed = 0,
  byFailureClass = {},
  cancelled = false,
  aborted = false,
} = {}) {
  const state = deriveTerminalState({ intended, succeeded, failed, cancelled, aborted });
  return {
    state,
    intended,
    succeeded,
    failed,
    outstanding: Math.max(0, intended - succeeded - failed),
    coveragePct: coveragePct(succeeded, intended),
    byFailureClass: { ...byFailureClass },
  };
}

module.exports = {
  // canonical failure-aware states
  LIFECYCLE_STATES,
  // re-exported registry state machine (single source of truth for transitions)
  RUN_STATUSES, RUN_TRANSITIONS, RUN_TERMINAL_STATUSES,
  isValidRunTransition, isTerminalRunStatus,
  // pure derivation
  coveragePct, deriveTerminalState, buildCompletionSummary,
};
