'use strict';

// Sprint 12 — canonical national runner. Wiring is exercised with injected
// adapters + fake deps (no live DB, no real population).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runNationalSignal, nationalAdapters } = require('./run-national');

function routingClient() {
  let seq = 0, ctx = {};
  const inserted = { signal_facts_demo: [] };
  function res() {
    const { table, op, payload } = ctx;
    if (table === 'collection_programmes') return { data: { id: 'prog-1', ...payload[0] }, error: null };
    if (table === 'collection_runs' && op === 'insert') return { data: { id: 'run-1', status: 'RUNNING', ...payload[0] }, error: null };
    if (table === 'collection_runs' && op === 'update') return { data: { id: 'run-1', ...payload }, error: null };
    if (table === 'signal_facts_demo') { const id = `obs-${++seq}`; inserted.signal_facts_demo.push({ id, ...payload[0] }); return { data: { id }, error: null }; }
    return { data: null, error: { message: 'unrouted' } };
  }
  const b = {
    from(t) { ctx = { table: t }; return b; }, upsert(r) { ctx.op = 'upsert'; ctx.payload = r; return b; },
    insert(r) { ctx.op = 'insert'; ctx.payload = r; return b; }, update(p) { ctx.op = 'update'; ctx.payload = p; return b; },
    select() { return b; }, eq() { return b; }, single() { return Promise.resolve(res()); }, maybeSingle() { return Promise.resolve(res()); }, order() { return Promise.resolve(res()); },
  };
  return { client: b, inserted };
}

const fakeAdapter = {
  signal: 'demo', tableName: 'signal_facts_demo',
  programme: { key: 'national-demo', name: 'D', kind: 'NATIONAL', signal: 'demo' },
  collect: async (d) => ({ d }),
  buildObservation: ({ domain, run, observedAt }) => ({ domain, collection_run_id: run.id, collection_programme_id: run.programme_id, collector: 'demo', collection_outcome: 'OBSERVED_PRESENT', collected_at: observedAt }),
};

describe('runNationalSignal', () => {
  test('routes a signal through the canonical session (programme + run + observations)', async () => {
    const { client, inserted } = routingClient();
    const result = await runNationalSignal({
      signal: 'demo', domains: ['a.com', 'b.com'], concurrency: 2,
      adapters: { demo: fakeAdapter },
      deps: { client, resolveOrganisation: () => ({ outcome: 'NOT_FOUND' }), now: () => 'T' },
    });
    assert.equal(result.counts.persisted, 2);
    assert.equal(result.programme.programme_key, 'national-demo');
    assert.equal(inserted.signal_facts_demo.length, 2);
  });

  test('unknown signal throws a helpful message', async () => {
    await assert.rejects(() => runNationalSignal({ signal: 'bogus', domains: ['a.com'] }), /no canonical national adapter/);
  });

  test('empty domains rejected', async () => {
    await assert.rejects(() => runNationalSignal({ signal: 'demo', domains: [], adapters: { demo: fakeAdapter } }), /non-empty array/);
  });
});

describe('national adapter set', () => {
  test('covers the 8 migrated signals; TLS/Certificate intentionally excluded', () => {
    const a = nationalAdapters();
    assert.deepEqual(Object.keys(a).sort(), ['caa', 'dkim', 'dmarc', 'dnssec', 'mtasts', 'securityheaders', 'securitytxt', 'spf']);
    assert.equal('tls' in a, false);
    assert.equal('certificate' in a, false);
  });

  test('CAA carries a collect override (dedicated resolver), others use the adapter as-is', () => {
    const a = nationalAdapters();
    assert.equal(typeof a.caa.collect, 'function');   // resolver-injecting override
    assert.equal(a.caa.tableName, 'signal_facts_caa');
    assert.equal(a.dkim.tableName, 'signal_facts_dkim');
    assert.equal(typeof a.dkim.persistChildren, 'function'); // DKIM child fan-out present
  });
});
