'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  LIFECYCLE_STATES, isValidRunTransition, isTerminalRunStatus,
  coveragePct, deriveTerminalState, buildCompletionSummary,
} = require('./run-lifecycle');

describe('lifecycle states + transitions (registry-backed)', () => {
  test('the failure-aware state set is present', () => {
    for (const s of ['CREATED', 'QUEUED', 'RUNNING', 'PARTIAL', 'FAILED', 'COMPLETED', 'CANCELLED']) {
      assert.ok(LIFECYCLE_STATES.includes(s), `${s} missing`);
    }
  });

  test('staged path CREATED → QUEUED → RUNNING is legal', () => {
    assert.ok(isValidRunTransition('CREATED', 'QUEUED'));
    assert.ok(isValidRunTransition('QUEUED', 'RUNNING'));
    assert.ok(isValidRunTransition('CREATED', 'RUNNING')); // runner may start immediately
  });

  test('RUNNING may finish to any truthful terminal', () => {
    for (const t of ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']) {
      assert.ok(isValidRunTransition('RUNNING', t), `RUNNING → ${t} should be legal`);
    }
  });

  test('cancellation is reachable before execution', () => {
    assert.ok(isValidRunTransition('CREATED', 'CANCELLED'));
    assert.ok(isValidRunTransition('QUEUED', 'CANCELLED'));
  });

  test('terminal states are terminal and have no outgoing transitions', () => {
    for (const t of ['PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED']) {
      assert.ok(isTerminalRunStatus(t));
      assert.ok(!isValidRunTransition(t, 'RUNNING'));
    }
  });

  test('illegal jumps are rejected', () => {
    assert.equal(isValidRunTransition('QUEUED', 'COMPLETED'), false); // must run first
    assert.equal(isValidRunTransition('COMPLETED', 'PARTIAL'), false);
    assert.equal(isValidRunTransition('PARTIAL', 'COMPLETED'), false);
  });
});

describe('coveragePct', () => {
  test('computes rounded percentage', () => {
    assert.equal(coveragePct(50, 100), 50);
    assert.equal(coveragePct(1, 3), 33.33);
    assert.equal(coveragePct(100, 100), 100);
  });
  test('empty intended set is 0%, never 100%', () => {
    assert.equal(coveragePct(0, 0), 0);
  });
});

describe('deriveTerminalState — truthful outcomes', () => {
  test('all succeeded → COMPLETED', () => {
    assert.equal(deriveTerminalState({ intended: 100, succeeded: 100, failed: 0 }), 'COMPLETED');
  });
  test('some failed after retries → PARTIAL (never COMPLETED)', () => {
    assert.equal(deriveTerminalState({ intended: 100, succeeded: 97, failed: 3 }), 'PARTIAL');
  });
  test('zero succeeded → FAILED', () => {
    assert.equal(deriveTerminalState({ intended: 100, succeeded: 0, failed: 100 }), 'FAILED');
  });
  test('aborted mid-run → FAILED even with progress', () => {
    assert.equal(deriveTerminalState({ intended: 100, succeeded: 40, failed: 5, aborted: true }), 'FAILED');
  });
  test('cancelled → CANCELLED (takes precedence over partial progress)', () => {
    assert.equal(deriveTerminalState({ intended: 100, succeeded: 40, failed: 0, cancelled: true }), 'CANCELLED');
  });
  test('outstanding (not-yet-attempted) work still counts against completion', () => {
    // 100 intended, 90 succeeded, 0 failed, 10 never attempted → not COMPLETED
    assert.equal(deriveTerminalState({ intended: 100, succeeded: 90, failed: 0 }), 'PARTIAL');
  });
});

describe('buildCompletionSummary', () => {
  test('produces coverage, counts, outstanding, and failure breakdown', () => {
    const s = buildCompletionSummary({
      intended: 200, succeeded: 185, failed: 12,
      byFailureClass: { PERMANENT: 10, RETRYABLE: 2 },
    });
    assert.equal(s.state, 'PARTIAL');
    assert.equal(s.intended, 200);
    assert.equal(s.succeeded, 185);
    assert.equal(s.failed, 12);
    assert.equal(s.outstanding, 3);
    assert.equal(s.coveragePct, 92.5);
    assert.deepEqual(s.byFailureClass, { PERMANENT: 10, RETRYABLE: 2 });
  });
  test('full success reports COMPLETED at 100%', () => {
    const s = buildCompletionSummary({ intended: 10, succeeded: 10, failed: 0 });
    assert.equal(s.state, 'COMPLETED');
    assert.equal(s.coveragePct, 100);
    assert.equal(s.outstanding, 0);
  });
});
