'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./test-helpers/fake-supabase');
const { runResilientCollectionSession } = require('./resilient-collection-session');
const registry = require('./registry');

const err = (props) => Object.assign(new Error(props.message || 'x'), props);
const noSleep = async () => {};

// A controllable adapter. `plan[domain]` decides how collect behaves; a spy
// records every domain collect() is actually called for (to prove resume never
// recollects a completed organisation).
function makeAdapter(plan = {}) {
  const attempts = {};
  const collectCalls = [];
  const adapter = {
    signal: 'demo',
    tableName: 'signal_facts_demo',
    programme: { key: 'national-demo', name: 'Demo', kind: 'NATIONAL', signal: 'demo' },
    async collect(domain) {
      collectCalls.push(domain);
      attempts[domain] = (attempts[domain] || 0) + 1;
      const spec = plan[domain] || { type: 'ok' };
      if (spec.type === 'ok') return { val: domain };
      if (spec.type === 'permanent') throw err({ code: 'ENOTFOUND', message: 'NXDOMAIN' });
      if (spec.type === 'transient-always') throw err({ code: 'ETIMEDOUT', message: 'timeout' });
      if (spec.type === 'transient-then-ok') {
        if (attempts[domain] <= (spec.failTimes ?? 1)) throw err({ code: 'ECONNRESET', message: 'reset' });
        return { val: domain };
      }
      if (spec.type === 'bug') throw new TypeError('collector bug');
      return { val: domain };
    },
    buildObservation({ domain, facts, run }) {
      return { domain, collection_run_id: run.id, collection_programme_id: run.programme_id, val: facts.val };
    },
  };
  return { adapter, collectCalls, attempts };
}

const baseDeps = (db) => ({
  client: db,
  resolveOrganisation: () => ({ outcome: 'NOT_FOUND' }),
  now: () => '2026-07-12T00:00:00.000Z',
  sleep: noSleep,
});

describe('resilient session — happy path (COMPLETED)', () => {
  test('all organisations collected → COMPLETED at 100% coverage, one observation each', async () => {
    const db = createFakeSupabase();
    const { adapter, collectCalls } = makeAdapter();
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-DEMO-1', domains: ['a.com', 'b.com', 'c.com'], adapter,
      deps: baseDeps(db), options: { concurrency: 3 },
    });
    assert.equal(r.summary.state, 'COMPLETED');
    assert.equal(r.summary.coveragePct, 100);
    assert.equal(r.summary.succeeded, 3);
    assert.equal(db._rows('signal_facts_demo').length, 3);
    assert.equal(r.run.status, 'COMPLETED');
    assert.equal(collectCalls.length, 3);
    // completion-summary columns persisted on the run
    assert.equal(r.run.succeeded_count, 3);
    assert.equal(r.run.coverage_pct, 100);
  });
});

describe('resilient session — retry behaviour', () => {
  test('a transient failure is retried and recovers within the run', async () => {
    const db = createFakeSupabase();
    const { adapter, attempts } = makeAdapter({ 'flaky.com': { type: 'transient-then-ok', failTimes: 2 } });
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-DEMO-2', domains: ['flaky.com', 'ok.com'], adapter,
      deps: baseDeps(db), options: { concurrency: 1, maxAttempts: 5, baseDelayMs: 1 },
    });
    assert.equal(r.summary.state, 'COMPLETED');
    assert.equal(attempts['flaky.com'], 3); // failed twice, succeeded on the 3rd
    const item = db._rows('collection_run_items').find((i) => i.domain === 'flaky.com');
    assert.equal(item.status, 'COMPLETED');
    assert.equal(item.attempts, 3);
  });

  test('a transient failure that never recovers is recorded FAILED (retryable class)', async () => {
    const db = createFakeSupabase();
    const { adapter, attempts } = makeAdapter({ 'down.com': { type: 'transient-always' } });
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-DEMO-3', domains: ['down.com', 'ok.com'], adapter,
      deps: baseDeps(db), options: { concurrency: 1, maxAttempts: 3, baseDelayMs: 1 },
    });
    assert.equal(attempts['down.com'], 3); // exhausted all attempts
    assert.equal(r.summary.state, 'PARTIAL');
    assert.equal(r.summary.byFailureClass.RETRYABLE, 1);
    const item = db._rows('collection_run_items').find((i) => i.domain === 'down.com');
    assert.equal(item.status, 'FAILED'); // retryable → FAILED (re-collectable on resume), not PERMANENT
  });
});

describe('resilient session — permanent & unexpected failures', () => {
  test('a permanent failure is not retried and parks as PERMANENT', async () => {
    const db = createFakeSupabase();
    const { adapter, attempts } = makeAdapter({ 'gone.com': { type: 'permanent' } });
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-DEMO-4', domains: ['gone.com', 'ok.com'], adapter,
      deps: baseDeps(db), options: { concurrency: 1, maxAttempts: 5, baseDelayMs: 1 },
    });
    assert.equal(attempts['gone.com'], 1); // never retried
    assert.equal(r.summary.state, 'PARTIAL');
    assert.equal(r.summary.byFailureClass.PERMANENT, 1);
    const item = db._rows('collection_run_items').find((i) => i.domain === 'gone.com');
    assert.equal(item.status, 'PERMANENT');
  });

  test('a collector bug (UNEXPECTED) is not retried and does not corrupt the run', async () => {
    const db = createFakeSupabase();
    const { adapter, attempts } = makeAdapter({ 'buggy.com': { type: 'bug' } });
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-DEMO-5', domains: ['buggy.com', 'ok.com'], adapter,
      deps: baseDeps(db), options: { concurrency: 1, maxAttempts: 5, baseDelayMs: 1 },
    });
    assert.equal(attempts['buggy.com'], 1);
    assert.equal(r.summary.byFailureClass.UNEXPECTED, 1);
  });
});

describe('resilient session — terminal states', () => {
  test('zero successes → FAILED', async () => {
    const db = createFakeSupabase();
    const { adapter } = makeAdapter({ a: { type: 'permanent' }, b: { type: 'permanent' } });
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-DEMO-6', domains: ['a', 'b'], adapter, deps: baseDeps(db), options: { concurrency: 2 },
    });
    assert.equal(r.summary.state, 'FAILED');
    assert.equal(r.run.status, 'FAILED');
  });

  test('cancellation → CANCELLED, unprocessed organisations remain outstanding', async () => {
    const db = createFakeSupabase();
    const { adapter, collectCalls } = makeAdapter();
    // cancel after the first organisation is processed
    let processed = 0;
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-DEMO-7', domains: ['a', 'b', 'c', 'd'], adapter,
      deps: baseDeps(db),
      options: { concurrency: 1, shouldCancel: () => { const stop = processed >= 1; processed += 1; return stop; } },
    });
    assert.equal(r.summary.state, 'CANCELLED');
    assert.ok(collectCalls.length < 4); // stopped early
    assert.equal(r.run.status, 'CANCELLED');
  });
});

describe('resilient session — resume after restart (crash-safe)', () => {
  // Simulate a crash by making the FIRST run's final transition throw AFTER all
  // per-organisation work + ledger writes have happened. The run row stays
  // RUNNING (never finalised). A second call with resume:true must adopt it,
  // recollect NOTHING (all already completed), write NO duplicate observations,
  // and finalise COMPLETED.
  test('a restarted run continues where it stopped and never recollects or duplicates', async () => {
    const db = createFakeSupabase();
    const domains = ['a.com', 'b.com', 'c.com'];

    // Pass 1 — crash at finalise.
    const first = makeAdapter();
    const throwingTransition = async () => { throw new Error('process killed before finalise'); };
    await assert.rejects(() => runResilientCollectionSession({
      runLabel: 'NOB-RESUME-1', domains, adapter: first.adapter,
      deps: { ...baseDeps(db), transitionRun: throwingTransition },
      options: { concurrency: 3 },
    }), /process killed/);

    // The run is still RUNNING; all 3 organisations are COMPLETED in the ledger.
    const runRow = db._rows('collection_runs')[0];
    assert.equal(runRow.status, 'RUNNING');
    assert.equal(db._rows('signal_facts_demo').length, 3);
    assert.equal(first.collectCalls.length, 3);

    // Pass 2 — resume with a fresh adapter (fresh collect spy).
    const second = makeAdapter();
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-RESUME-1', domains, adapter: second.adapter,
      deps: baseDeps(db), options: { concurrency: 3, resume: true },
    });

    assert.equal(r.resumed, true);
    assert.equal(r.summary.state, 'COMPLETED');
    assert.equal(second.collectCalls.length, 0);            // nothing recollected
    assert.equal(db._rows('signal_facts_demo').length, 3);  // no duplicate observations
    assert.equal(db._rows('collection_runs').length, 1);    // no duplicate run
  });

  test('resume completes only the outstanding organisations from an interrupted run', async () => {
    const db = createFakeSupabase();
    const domains = ['a.com', 'b.com', 'c.com', 'd.com'];

    // Pass 1 — b.com & d.com fail transiently and are exhausted (FAILED, i.e.
    // still outstanding); a.com & c.com succeed. Crash at finalise.
    const first = makeAdapter({ 'b.com': { type: 'transient-always' }, 'd.com': { type: 'transient-always' } });
    await assert.rejects(() => runResilientCollectionSession({
      runLabel: 'NOB-RESUME-2', domains, adapter: first.adapter,
      deps: { ...baseDeps(db), transitionRun: async () => { throw new Error('crash'); } },
      options: { concurrency: 1, maxAttempts: 2, baseDelayMs: 1 },
    }), /crash/);

    assert.equal(db._rows('signal_facts_demo').length, 2); // a.com, c.com

    // Pass 2 — resume; this time b.com & d.com are healthy.
    const second = makeAdapter(); // all ok
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-RESUME-2', domains, adapter: second.adapter,
      deps: baseDeps(db), options: { concurrency: 2, resume: true },
    });

    assert.equal(r.resumed, true);
    assert.equal(r.summary.state, 'COMPLETED');
    assert.deepEqual(second.collectCalls.sort(), ['b.com', 'd.com']); // only the outstanding two
    assert.equal(db._rows('signal_facts_demo').length, 4);            // 2 + 2, no duplicates
  });

  test('duplicate-prevention guard adopts an orphaned observation from a crash mid-write', async () => {
    // Seed the exact state of a crash AFTER an observation INSERT but BEFORE the
    // ledger markCompleted: run RUNNING, item PENDING, observation already exists.
    const db = createFakeSupabase({
      collection_programmes: [{ id: 'prog-1', programme_key: 'national-demo', kind: 'NATIONAL' }],
      collection_runs: [{ id: 'run-1', programme_id: 'prog-1', run_label: 'NOB-RESUME-3', status: 'RUNNING', started_at: '2026-07-12T00:00:00.000Z' }],
      collection_run_items: [{ id: 'it-1', collection_run_id: 'run-1', domain: 'orphan.com', status: 'PENDING', attempts: 1 }],
      signal_facts_demo: [{ id: '33333333-3333-3333-3333-333333333333', collection_run_id: 'run-1', domain: 'orphan.com', val: 'orphan.com' }],
    });
    const { adapter, collectCalls } = makeAdapter();
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-RESUME-3', domains: ['orphan.com'], adapter,
      deps: baseDeps(db), options: { concurrency: 1, resume: true },
    });

    assert.equal(r.resumed, true);
    assert.equal(r.summary.state, 'COMPLETED');
    assert.equal(collectCalls.length, 0);                        // never recollected
    assert.equal(db._rows('signal_facts_demo').length, 1);       // NO duplicate observation
    const item = db._rows('collection_run_items').find((i) => i.domain === 'orphan.com');
    assert.equal(item.status, 'COMPLETED');
    assert.equal(item.observation_id, '33333333-3333-3333-3333-333333333333'); // adopted the orphan
    // The adopt path deliberately does NOT emit a Constitutional Event — the
    // Observation was not freshly created by this call, so emitting here would
    // risk a duplicate Event for an Observation whose original Event may (or may
    // not) already exist from before the crash. See F4 emission tests below.
    assert.equal(db._rows('events').length, 0);
  });
});

describe('constitutional Event emission (F4 — OBS-CONST-001 §4)', () => {
  test('each freshly-persisted Observation emits exactly one Observation Event, envelope-only (no interpretation)', async () => {
    const db = createFakeSupabase();
    const { adapter } = makeAdapter();
    const resolveResolved = (domain) => ({ outcome: 'RESOLVED', organisationId: `ORG-${domain}`, provenance: { authorityVersion: 'v2' } });
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-EVT-1', domains: ['a.com', 'b.com'], adapter,
      deps: { ...baseDeps(db), resolveOrganisation: resolveResolved }, options: { concurrency: 2 },
    });
    assert.equal(r.summary.state, 'COMPLETED');
    const events = db._rows('events');
    assert.equal(events.length, 2); // one per persisted Observation
    for (const ev of events) {
      assert.equal(ev.subject_type, 'Observation');
      assert.equal(ev.subject_id, r.run.id); // collection_run_id
      assert.equal(ev.repository_authority_version, 'authority@v2');
      assert.equal(ev.quality_model_version, null, 'no Quality Model version — Events are observational, never interpretive');
      assert.match(ev.organisation_id, /^ORG-[ab]\.com$/);
      assert.ok(ev.metadata && ev.metadata.domain && ev.metadata.observationId, 'metadata is descriptive only (domain/observationId/signal)');
      assert.equal(JSON.stringify(ev).match(/score|band|verdict|trust/i), null);
    }
  });

  test('organisation_id is null on the Event when the domain does not resolve (Unknown ≠ Absent)', async () => {
    const db = createFakeSupabase();
    const { adapter } = makeAdapter();
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-EVT-2', domains: ['unresolved.com'], adapter,
      deps: baseDeps(db), // baseDeps resolves NOT_FOUND
      options: { concurrency: 1 },
    });
    assert.equal(r.summary.state, 'COMPLETED');
    const events = db._rows('events');
    assert.equal(events.length, 1);
    assert.equal(events[0].organisation_id, null);
  });

  test('a FAILED organisation (never persisted) emits no Event', async () => {
    const db = createFakeSupabase();
    const { adapter } = makeAdapter({ 'gone.com': { type: 'permanent' } });
    await runResilientCollectionSession({
      runLabel: 'NOB-EVT-3', domains: ['gone.com', 'ok.com'], adapter,
      deps: baseDeps(db), options: { concurrency: 2 },
    });
    // ok.com persisted → 1 event; gone.com never persisted → no event for it.
    assert.equal(db._rows('events').length, 1);
    assert.equal(db._rows('events')[0].metadata.domain, 'ok.com');
  });

  test('an Event-write failure never fails the run — Observation persistence outranks Event bookkeeping', async () => {
    const db = createFakeSupabase();
    const { adapter } = makeAdapter();
    // Wrap the client so inserts into "events" specifically fail; everything else
    // behaves normally via the real fake-supabase builder.
    const brokenEventsInsert = {
      select() {
        return { single() { return Promise.resolve({ data: null, error: { message: 'events table unavailable' } }); } };
      },
    };
    const brokenEventsClient = {
      from(t) {
        if (t !== 'events') return db.from(t);
        return { insert() { return brokenEventsInsert; } };
      },
    };
    const r = await runResilientCollectionSession({
      runLabel: 'NOB-EVT-4', domains: ['a.com'], adapter,
      deps: { ...baseDeps(db), client: brokenEventsClient }, options: { concurrency: 1 },
    });
    // The Observation is still persisted and the run still completes normally.
    assert.equal(r.summary.state, 'COMPLETED');
    assert.equal(r.summary.succeeded, 1);
    assert.equal(db._rows('signal_facts_demo').length, 1);
  });
});
