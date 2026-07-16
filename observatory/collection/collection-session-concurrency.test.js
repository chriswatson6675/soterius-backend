'use strict';

// Sprint 12 — Collection Session concurrency + child-persistence (persistChildren).
// Additive framework capabilities needed to migrate national collections.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runCollectionSession } = require('./collection-session');
const { dkimAdapter } = require('../../collection/signals/dkim/dkim-observation');

const STUB_RESOLVE = () => ({ outcome: 'NOT_FOUND' });

// Routing fake client; `then` makes the builder awaitable so a terminal-less
// `.insert(rows)` (child writes) resolves like a real PostgREST builder.
function routingClient(parentTable = 'signal_facts_demo', childTable = null) {
  const inserted = { collection_programmes: [], collection_runs: [], [parentTable]: [] };
  if (childTable) inserted[childTable] = [];
  let seq = 0, ctx = {};
  function res() {
    const { table, op, payload } = ctx;
    if (table === 'collection_programmes') return { data: { id: 'prog-1', ...payload[0] }, error: null };
    if (table === 'collection_runs' && op === 'insert') return { data: { id: 'run-1', status: 'RUNNING', ...payload[0] }, error: null };
    if (table === 'collection_runs' && op === 'update') return { data: { id: 'run-1', ...payload }, error: null };
    if (table === parentTable) { const id = `obs-${++seq}`; inserted[parentTable].push({ id, ...payload[0] }); return { data: { id }, error: null }; }
    // Supabase's real .insert() accepts either a single object or an array —
    // persistDkimKeys now inserts one row at a time (a single object), not
    // the original bulk array; normalize here rather than assume one shape.
    if (childTable && table === childTable && op === 'insert') { (Array.isArray(payload) ? payload : [payload]).forEach((r) => inserted[childTable].push(r)); return { data: null, error: null }; }
    // A plain select/eq (no insert/update/upsert op) against the child table —
    // persistDkimKeys' own idempotency pre-check. No pre-existing children in
    // this harness, so it's always empty (fresh insert every time).
    if (childTable && table === childTable) return { data: [], error: null };
    return { data: null, error: { message: 'unrouted ' + table } };
  }
  const b = {
    from(t) { ctx = { table: t }; return b; },
    upsert(r) { ctx.op = 'upsert'; ctx.payload = r; return b; },
    insert(r) { ctx.op = 'insert'; ctx.payload = r; return b; },
    update(p) { ctx.op = 'update'; ctx.payload = p; return b; },
    select() { return b; }, eq() { return b; },
    single() { return Promise.resolve(res()); },
    maybeSingle() { return Promise.resolve(res()); },
    order() { return Promise.resolve(res()); },
    then(onF, onR) { try { onF(res()); } catch (e) { if (onR) onR(e); } },
  };
  return { client: b, inserted };
}

const demoAdapter = (collect) => ({
  signal: 'demo', tableName: 'signal_facts_demo',
  programme: { key: 'national-demo', name: 'D', kind: 'NATIONAL', signal: 'demo' },
  collect,
  buildObservation: ({ domain, run, observedAt }) => ({
    domain, collection_run_id: run.id, collection_programme_id: run.programme_id,
    collector: 'demo', collection_outcome: 'OBSERVED_PRESENT', collected_at: observedAt,
  }),
});

describe('concurrency', () => {
  test('concurrency > 1 runs domains in parallel; all persisted, index order preserved', async () => {
    let inFlight = 0, maxInFlight = 0;
    const collect = async (d) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { d }; };
    const { client } = routingClient();
    const result = await runCollectionSession({
      runLabel: 'C', domains: ['a', 'b', 'c', 'd', 'e', 'f'], adapter: demoAdapter(collect),
      deps: { client, resolveOrganisation: STUB_RESOLVE, concurrency: 3, now: () => 'T' },
    });
    assert.equal(result.counts.persisted, 6);
    assert.deepEqual(result.observations.map((o) => o.domain), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.ok(maxInFlight >= 2, `expected parallelism, saw max ${maxInFlight}`);
  });

  test('default concurrency 1 is strictly sequential', async () => {
    let inFlight = 0, maxInFlight = 0;
    const collect = async (d) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 2)); inFlight--; return { d }; };
    const { client } = routingClient();
    await runCollectionSession({ runLabel: 'S', domains: ['a', 'b', 'c'], adapter: demoAdapter(collect), deps: { client, resolveOrganisation: STUB_RESOLVE, now: () => 'T' } });
    assert.equal(maxInFlight, 1);
  });
});

describe('persistChildren (DKIM key fan-out)', () => {
  test('DKIM keys are written to signal_facts_dkim_keys after the parent, PARENT-ROW-linked (not run-linked)', async () => {
    // Regression test for the OBS-102 supervised-trial defect (2026-07-16):
    // this assertion previously expected key.dkim_run_id === 'run-1' (the
    // collection run's id) — which is exactly the bug. The column is a
    // foreign key to signal_facts_dkim(id), the PARENT ROW's own id, and
    // must reference that instead.
    const facts = {
      dkim_present: true, dkim_collection_status: null, dkim_record_count: 1,
      dkim_selectors_probed: ['google'], dkim_selectors_found: ['google'], dkim_probe_set_version: 1,
      dkim_keys: [{ selector: 'google', raw_record: 'v=DKIM1; p=X', parse_success: true, key_bits: 2048, public_key_present: true, flags: [] }],
    };
    const { client, inserted } = routingClient('signal_facts_dkim', 'signal_facts_dkim_keys');
    const result = await runCollectionSession({
      runLabel: 'DKIM', domains: ['x.com'], adapter: dkimAdapter,
      deps: { client, collect: async () => facts, resolveOrganisation: STUB_RESOLVE, now: () => 'T' },
    });
    assert.equal(result.counts.persisted, 1);
    // parent domain-level row has the envelope, NOT the keys
    assert.equal('dkim_keys' in inserted['signal_facts_dkim'][0], false);
    const parentId = inserted['signal_facts_dkim'][0].id;
    // child keys fanned out, PARENT-linked, timestamp-matched
    assert.equal(inserted['signal_facts_dkim_keys'].length, 1);
    const key = inserted['signal_facts_dkim_keys'][0];
    assert.equal(key.dkim_run_id, parentId);
    assert.notEqual(key.dkim_run_id, 'run-1');
    assert.equal(key.collected_at, 'T');
    assert.equal(key.selector, 'google');
    assert.equal(key.key_bits, 2048);
  });

  test('no keys → no child rows, still persists the parent', async () => {
    const facts = { dkim_present: null, dkim_collection_status: 'NOT_DETECTED', dkim_keys: [] };
    const { client, inserted } = routingClient('signal_facts_dkim', 'signal_facts_dkim_keys');
    const result = await runCollectionSession({ runLabel: 'DKIM', domains: ['x.com'], adapter: dkimAdapter, deps: { client, collect: async () => facts, resolveOrganisation: STUB_RESOLVE, now: () => 'T' } });
    assert.equal(result.counts.persisted, 1);
    assert.equal(inserted['signal_facts_dkim_keys'].length, 0);
  });
});
