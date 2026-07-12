'use strict';

// Sprint 8 — generic Collection Session framework.
// Exercises the framework with a FAKE, non-DNSSEC signal adapter to prove it
// contains no signal-specific logic: real orchestration + real registry builders
// against a routing fake client. If this passes for an invented "demo" signal,
// the framework is genuinely signal-agnostic.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runCollectionSession } = require('./collection-session');

// ── A minimal fake signal adapter (no real collector, no real table) ─────────
const demoAdapter = {
  signal: 'demo',
  tableName: 'signal_facts_demo',
  programme: { key: 'national-demo', name: 'National Demo', kind: 'NATIONAL', signal: 'demo' },
  collect: async (domain) => ({ value: domain === 'present.test' ? 1 : 0 }),
  buildObservation: ({ domain, facts, run, observedAt }) => ({
    domain,
    observed_value: facts.value,
    collected_at: observedAt,
    collection_run_id: run.id,
    collection_programme_id: run.programme_id,
    collector: 'demo',
    collection_outcome: facts.value > 0 ? 'OBSERVED_PRESENT' : 'OBSERVED_ABSENT',
  }),
};

// ── Routing fake client (captures inserts, routes by table+op) ───────────────
function routingClient() {
  const inserted = { collection_programmes: [], collection_runs: [], signal_facts_demo: [], events: [] };
  let seq = 0, eventSeq = 0, ctx = {};
  function resolve() {
    const { table, op, payload } = ctx;
    if (table === 'collection_programmes' && op === 'upsert') { const r = { id: 'prog-1', ...payload[0] }; inserted.collection_programmes.push(r); return { data: r, error: null }; }
    if (table === 'collection_runs' && op === 'insert') { const r = { id: 'run-1', status: 'RUNNING', ...payload[0] }; inserted.collection_runs.push(r); return { data: r, error: null }; }
    if (table === 'collection_runs' && op === 'update') return { data: { id: 'run-1', ...payload }, error: null };
    if (table === 'signal_facts_demo' && op === 'insert') { const id = `obs-${++seq}`; inserted.signal_facts_demo.push({ id, ...payload[0] }); return { data: { id }, error: null }; }
    if (table === 'events' && op === 'insert') { const event_id = `event-${++eventSeq}`; const r = { event_id, ...payload[0] }; inserted.events.push(r); return { data: r, error: null }; }
    return { data: null, error: { message: `unrouted ${table}/${op}` } };
  }
  const b = {
    from(t){ ctx = { table: t }; return b; },
    upsert(r){ ctx.op='upsert'; ctx.payload=r; return b; },
    insert(r){ ctx.op='insert'; ctx.payload=r; return b; },
    update(p){ ctx.op='update'; ctx.payload=p; return b; },
    select(){ return b; }, eq(){ return b; },
    single(){ return Promise.resolve(resolve()); },
    maybeSingle(){ return Promise.resolve(resolve()); },
    order(){ return Promise.resolve(resolve()); },
  };
  return { client: b, inserted };
}

// Stub resolver keeps the framework tests hermetic (no Repository Authority load).
const STUB_RESOLVE = () => ({ outcome: 'NOT_FOUND' });

const run = (client, extra = {}) => runCollectionSession({
  runLabel: 'DEMO-RUN',
  domains: ['present.test', 'absent.test'],
  adapter: demoAdapter,
  ...extra,
  deps: { client, resolveOrganisation: STUB_RESOLVE, now: () => 'T', ...(extra.deps || {}) },
});

describe('generic framework is signal-agnostic (proven with a fake signal)', () => {
  test('opens programme + run, persists one observation per domain, completes run', async () => {
    const { client, inserted } = routingClient();
    const result = await run(client);

    assert.equal(inserted.collection_programmes[0].programme_key, 'national-demo');
    assert.equal(inserted.collection_runs[0].programme_id, 'prog-1');
    assert.equal(inserted.signal_facts_demo.length, 2);
    assert.equal(result.run.status, 'COMPLETED');
    assert.deepEqual(result.counts, { total: 2, persisted: 2, failed: 0 });
  });

  test('every observation is owned by the run + programme and carries the adapter-built fields', async () => {
    const { client, inserted } = routingClient();
    await run(client);
    for (const o of inserted.signal_facts_demo) {
      assert.equal(o.collection_run_id, 'run-1');
      assert.equal(o.collection_programme_id, 'prog-1');
      assert.equal(o.collector, 'demo');
      assert.equal(o.collected_at, 'T');
    }
    const byDomain = Object.fromEntries(inserted.signal_facts_demo.map(o => [o.domain, o]));
    assert.equal(byDomain['present.test'].collection_outcome, 'OBSERVED_PRESENT');
    assert.equal(byDomain['absent.test'].collection_outcome, 'OBSERVED_ABSENT');
  });

  test('persists into the adapter-specified table, not a hardcoded one', async () => {
    const { client, inserted } = routingClient();
    await run(client);
    // The framework wrote to signal_facts_demo purely because the adapter said so.
    assert.equal(inserted.signal_facts_demo.length, 2);
  });

  test('a per-domain collect failure is recorded, run still completes', async () => {
    const { client } = routingClient();
    const failing = { ...demoAdapter, collect: async (d) => { if (d === 'absent.test') throw new Error('collector boom'); return { value: 1 }; } };
    const result = await runCollectionSession({ runLabel: 'DEMO', domains: ['present.test', 'absent.test'], adapter: failing, deps: { client, resolveOrganisation: STUB_RESOLVE, now: () => 'T' } });
    assert.deepEqual(result.counts, { total: 2, persisted: 1, failed: 1 });
    assert.equal(result.run.status, 'COMPLETED');
  });

  test('a persist error is recorded as a failed observation', async () => {
    const { client } = routingClient();
    // Wrap the client so signal_facts_demo inserts error out.
    const erroring = {
      from(t) { const inner = client.from(t); if (t === 'signal_facts_demo') { return { insert(){ return { select(){ return { single(){ return Promise.resolve({ data: null, error: { message: 'insert denied' } }); } }; } }; } }; } return inner; },
    };
    const result = await runCollectionSession({ runLabel: 'DEMO', domains: ['present.test'], adapter: demoAdapter, deps: { client: erroring, resolveOrganisation: STUB_RESOLVE, now: () => 'T' } });
    assert.equal(result.counts.failed, 1);
    assert.match(result.observations[0].error, /insert denied/);
  });
});

describe('constitutional Event emission (F4 — OBS-CONST-001 §4)', () => {
  test('a successfully persisted Observation emits exactly one Observation Event, envelope-only (no interpretation)', async () => {
    const { client, inserted } = routingClient();
    const resolveResolved = () => ({ outcome: 'RESOLVED', organisationId: 'ORG-DEMO123', provenance: { authorityVersion: 'v1' } });
    await runCollectionSession({
      runLabel: 'DEMO-RUN', domains: ['present.test'], adapter: demoAdapter,
      deps: { client, resolveOrganisation: resolveResolved, now: () => 'T' },
    });
    assert.equal(inserted.events.length, 1);
    const ev = inserted.events[0];
    assert.equal(ev.subject_type, 'Observation');
    assert.equal(ev.subject_id, 'run-1'); // collection_run_id
    assert.equal(ev.organisation_id, 'ORG-DEMO123');
    assert.equal(ev.occurred_at, 'T');
    assert.equal(ev.repository_authority_version, 'authority@v1');
    assert.equal(ev.quality_model_version, null, 'no Quality Model version — Events are observational, never interpretive');
    assert.deepEqual(Object.keys(ev.metadata).sort(), ['domain', 'observationId', 'signal']);
    assert.equal(ev.metadata.signal, 'demo');
    // Purely descriptive metadata — no score/band/verdict anywhere in the event.
    assert.equal(JSON.stringify(ev).match(/score|band|verdict|trust/i), null);
  });

  test('organisation_id is null on the Event when the domain does not resolve (Unknown ≠ Absent — the Event is still recorded)', async () => {
    const { client, inserted } = routingClient();
    await runCollectionSession({
      runLabel: 'DEMO-RUN', domains: ['present.test'], adapter: demoAdapter,
      deps: { client, resolveOrganisation: STUB_RESOLVE, now: () => 'T' }, // STUB_RESOLVE → NOT_FOUND
    });
    assert.equal(inserted.events.length, 1);
    assert.equal(inserted.events[0].organisation_id, null);
  });

  test('one Event per persisted Observation — a per-domain failure produces no Event for that domain', async () => {
    const { client, inserted } = routingClient();
    const failing = { ...demoAdapter, collect: async (d) => { if (d === 'absent.test') throw new Error('collector boom'); return { value: 1 }; } };
    const result = await runCollectionSession({
      runLabel: 'DEMO', domains: ['present.test', 'absent.test'], adapter: failing,
      deps: { client, resolveOrganisation: STUB_RESOLVE, now: () => 'T' },
    });
    assert.equal(result.counts.persisted, 1);
    assert.equal(inserted.events.length, 1); // only the successful domain emitted an Event
  });

  test('an Event-write failure never fails the run — Observation persistence outranks Event bookkeeping', async () => {
    // routingClient's default table set does not include "events" unless we ask
    // for it — reuse a client that never routes events to simulate the failure.
    const inserted = { collection_programmes: [], collection_runs: [], signal_facts_demo: [] };
    let seq = 0, ctx = {};
    function resolve() {
      const { table, op, payload } = ctx;
      if (table === 'collection_programmes' && op === 'upsert') { const r = { id: 'prog-1', ...payload[0] }; inserted.collection_programmes.push(r); return { data: r, error: null }; }
      if (table === 'collection_runs' && op === 'insert') { const r = { id: 'run-1', status: 'RUNNING', ...payload[0] }; inserted.collection_runs.push(r); return { data: r, error: null }; }
      if (table === 'collection_runs' && op === 'update') return { data: { id: 'run-1', ...payload }, error: null };
      if (table === 'signal_facts_demo' && op === 'insert') { const id = `obs-${++seq}`; inserted.signal_facts_demo.push({ id, ...payload[0] }); return { data: { id }, error: null }; }
      return { data: null, error: { message: `unrouted ${table}/${op}` } }; // "events" deliberately unrouted
    }
    const noEventsClient = {
      from(t){ ctx = { table: t }; return noEventsClient; },
      upsert(r){ ctx.op='upsert'; ctx.payload=r; return noEventsClient; },
      insert(r){ ctx.op='insert'; ctx.payload=r; return noEventsClient; },
      update(p){ ctx.op='update'; ctx.payload=p; return noEventsClient; },
      select(){ return noEventsClient; }, eq(){ return noEventsClient; },
      single(){ return Promise.resolve(resolve()); },
      maybeSingle(){ return Promise.resolve(resolve()); },
      order(){ return Promise.resolve(resolve()); },
    };
    const result = await runCollectionSession({
      runLabel: 'DEMO-RUN', domains: ['present.test'], adapter: demoAdapter,
      deps: { client: noEventsClient, resolveOrganisation: STUB_RESOLVE, now: () => 'T' },
    });
    // The Observation is still persisted and the run still completes, despite the events table being unroutable.
    assert.equal(result.counts.persisted, 1);
    assert.equal(inserted.signal_facts_demo.length, 1);
    assert.equal(result.run.status, 'COMPLETED');
  });
});

describe('input validation', () => {
  test('missing adapter / tableName / programme.key / runLabel / domains throw', async () => {
    const { client } = routingClient();
    await assert.rejects(() => runCollectionSession({ runLabel: 'x', domains: ['a'], deps: { client } }), /signal adapter is required/);
    await assert.rejects(() => runCollectionSession({ runLabel: 'x', domains: ['a'], adapter: { programme: { key: 'k' } }, deps: { client } }), /tableName is required/);
    await assert.rejects(() => runCollectionSession({ runLabel: 'x', domains: ['a'], adapter: { tableName: 't', programme: {} }, deps: { client } }), /programme.key is required/);
    await assert.rejects(() => runCollectionSession({ domains: ['a'], adapter: demoAdapter, deps: { client } }), /runLabel is required/);
    await assert.rejects(() => runCollectionSession({ runLabel: 'x', domains: [], adapter: demoAdapter, deps: { client } }), /non-empty array/);
  });
});
