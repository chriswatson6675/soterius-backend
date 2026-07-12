'use strict';

// Stress test — simulated NATIONAL collection through the production-hardened
// resilient path. Exercises the success criteria at scale against the stateful
// in-memory Supabase fake: no duplicate observations, no duplicate Collection
// Sessions (runs), resumable execution, truthful run status, automatic recovery
// from transient failures, and immutable evidence (insert-only).
//
// This is deterministic (seeded pseudo-randomness by index, injected no-op sleep)
// so it runs in CI without a live DB and without real timers.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('../../../observatory/collection/test-helpers/fake-supabase');
const { runResilientCollectionSession } = require('../../../observatory/collection/resilient-collection-session');

const N = 5000; // simulated national cohort size
const noSleep = async () => {};

// Deterministic fault plan keyed by domain index — a realistic national mix:
//   ~2%  permanent (NXDOMAIN)         → PERMANENT, never retried, never recovers
//   ~5%  transient-then-ok            → recovered by retry within the run
//   ~1%  transient-always             → FAILED after retries (outstanding)
//   rest healthy
function faultFor(i) {
  if (i % 50 === 0) return { type: 'permanent' };          // 2%
  if (i % 20 === 0) return { type: 'transient-then-ok' };  // ~5%
  if (i % 97 === 0) return { type: 'transient-always' };   // ~1%
  return { type: 'ok' };
}

function makeNationalAdapter() {
  const attempts = {};
  let collectCount = 0;
  const adapter = {
    signal: 'spf',
    tableName: 'signal_facts_spf',
    programme: { key: 'national-spf', name: 'National SPF', kind: 'NATIONAL', signal: 'spf' },
    async collect(domain) {
      collectCount += 1;
      const i = Number(/org-(\d+)/.exec(domain)[1]);
      attempts[domain] = (attempts[domain] || 0) + 1;
      const spec = faultFor(i);
      if (spec.type === 'permanent') throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' });
      if (spec.type === 'transient-always') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      if (spec.type === 'transient-then-ok' && attempts[domain] < 2) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      return { spf: 'v=spf1 -all' };
    },
    buildObservation({ domain, facts, run }) {
      return { domain, collection_run_id: run.id, collection_programme_id: run.programme_id, spf: facts.spf };
    },
  };
  return { adapter, get collectCount() { return collectCount; } };
}

const domains = Array.from({ length: N }, (_, i) => `org-${i}.example`);
const deps = (db) => ({ client: db, resolveOrganisation: () => ({ outcome: 'NOT_FOUND' }), sleep: noSleep, now: () => '2026-07-12T00:00:00.000Z' });

describe('simulated national collection (stress)', () => {
  test('completes a national run with truthful PARTIAL status and no duplicate evidence', async () => {
    const db = createFakeSupabase();
    const { adapter } = makeNationalAdapter();

    const r = await runResilientCollectionSession({
      runLabel: 'NOB-SPF-NATIONAL', domains, adapter,
      deps: deps(db), options: { concurrency: 32, maxAttempts: 3, baseDelayMs: 0 },
    });

    // Expected outcome counts from the deterministic fault plan.
    const permanent = domains.filter((_, i) => i % 50 === 0).length;
    const transientAlways = domains.filter((_, i) => i % 97 === 0 && i % 50 !== 0 && i % 20 !== 0).length;
    const succeeded = N - permanent - transientAlways;

    // Truthful status: some organisations remain failed after retries → PARTIAL.
    assert.equal(r.summary.state, 'PARTIAL');
    assert.equal(r.summary.intended, N);
    assert.equal(r.summary.succeeded, succeeded);
    assert.equal(r.summary.failed, permanent + transientAlways);
    assert.ok(r.summary.byFailureClass.PERMANENT >= permanent);

    // Immutable evidence: exactly one observation per succeeded organisation.
    const obs = db._rows('signal_facts_spf');
    assert.equal(obs.length, succeeded);
    // No duplicate observations (unique by domain).
    assert.equal(new Set(obs.map((o) => o.domain)).size, obs.length);

    // No duplicate Collection Session/run.
    assert.equal(db._rows('collection_runs').length, 1);
    // One ledger item per organisation.
    assert.equal(db._rows('collection_run_items').length, N);
  });

  test('resume after a mid-run crash recollects only outstanding orgs and never duplicates', async () => {
    const db = createFakeSupabase();

    // Pass 1 — the same national run, but crash at finalise (process killed). All
    // per-organisation work + ledger writes have already happened.
    const first = makeNationalAdapter();
    await assert.rejects(() => runResilientCollectionSession({
      runLabel: 'NOB-SPF-RESUME', domains, adapter: first.adapter,
      deps: { ...deps(db), transitionRun: async () => { throw new Error('killed'); } },
      options: { concurrency: 32, maxAttempts: 2, baseDelayMs: 0 },
    }), /killed/);

    const runRow = db._rows('collection_runs')[0];
    assert.equal(runRow.status, 'RUNNING');                 // never finalised
    const obsAfterCrash = db._rows('signal_facts_spf').length;
    const outstandingItems = db._rows('collection_run_items').filter((i) => ['PENDING', 'RUNNING', 'FAILED'].includes(i.status)).length;
    assert.ok(outstandingItems > 0);                         // transient-always orgs still open

    // Pass 2 — resume. This time the previously-transient-always orgs are healthy.
    const second = makeNationalAdapterAllHealthy();
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-SPF-RESUME', domains, adapter: second.adapter,
      deps: deps(db), options: { concurrency: 32, resume: true, maxAttempts: 3, baseDelayMs: 0 },
    });

    assert.equal(r.resumed, true);
    // Only outstanding organisations were recollected — far fewer than N.
    assert.ok(second.collectCount <= outstandingItems, `recollected ${second.collectCount} > outstanding ${outstandingItems}`);
    assert.ok(second.collectCount < N);

    // No duplicate observations: still one per succeeded domain, and >= the count
    // after the crash (resume only adds, never rewrites).
    const obs = db._rows('signal_facts_spf');
    assert.equal(new Set(obs.map((o) => o.domain)).size, obs.length);
    assert.ok(obs.length >= obsAfterCrash);

    // Only the permanent NXDOMAIN orgs remain unrecovered → PARTIAL, and still one run.
    const permanent = domains.filter((_, i) => i % 50 === 0).length;
    assert.equal(r.summary.succeeded, N - permanent);
    assert.equal(r.summary.state, 'PARTIAL');
    assert.equal(db._rows('collection_runs').length, 1);
  });
});

// A second-pass adapter where the previously-transient failures now succeed
// (only the true NXDOMAIN permanents still fail), to verify resume recovery.
function makeNationalAdapterAllHealthy() {
  let collectCount = 0;
  const adapter = {
    signal: 'spf', tableName: 'signal_facts_spf',
    programme: { key: 'national-spf', name: 'National SPF', kind: 'NATIONAL', signal: 'spf' },
    async collect(domain) {
      collectCount += 1;
      const i = Number(/org-(\d+)/.exec(domain)[1]);
      if (i % 50 === 0) throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' }); // still permanently dead
      return { spf: 'v=spf1 -all' };
    },
    buildObservation({ domain, facts, run }) {
      return { domain, collection_run_id: run.id, collection_programme_id: run.programme_id, spf: facts.spf };
    },
  };
  return { adapter, get collectCount() { return collectCount; } };
}
