'use strict';

// Sprint 10 — Observation persistence populates organisation_id from the resolver,
// RESOLVED only. Uses the real session + a fake client + an injected resolver so
// the wiring is exercised without a live DB or the Repository Authority dataset.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runCollectionSession } = require('./collection-session');

const demoAdapter = {
  signal: 'demo', tableName: 'signal_facts_demo',
  programme: { key: 'national-demo', name: 'National Demo', kind: 'NATIONAL', signal: 'demo' },
  collect: async () => ({ value: 1 }),
  buildObservation: ({ domain, facts, run, observedAt, organisationId, repositoryAuthorityRef }) => ({
    domain, observed_value: facts.value, collected_at: observedAt,
    collection_run_id: run.id, collection_programme_id: run.programme_id, collector: 'demo',
    collection_outcome: 'OBSERVED_PRESENT',
    organisation_id: organisationId ?? null,
    repository_authority_ref: repositoryAuthorityRef ?? null,
  }),
};

function routingClient() {
  const inserted = { collection_programmes: [], collection_runs: [], signal_facts_demo: [] };
  let seq = 0, ctx = {};
  function resolveRow() {
    const { table, op, payload } = ctx;
    if (table === 'collection_programmes') { const r = { id: 'prog-1', ...payload[0] }; inserted.collection_programmes.push(r); return { data: r, error: null }; }
    if (table === 'collection_runs' && op === 'insert') { const r = { id: 'run-1', status: 'RUNNING', ...payload[0] }; inserted.collection_runs.push(r); return { data: r, error: null }; }
    if (table === 'collection_runs' && op === 'update') return { data: { id: 'run-1', ...payload }, error: null };
    if (table === 'signal_facts_demo') { const id = `obs-${++seq}`; inserted.signal_facts_demo.push({ id, ...payload[0] }); return { data: { id }, error: null }; }
    return { data: null, error: { message: 'unrouted' } };
  }
  const b = {
    from(t) { ctx = { table: t }; return b; },
    upsert(r) { ctx.op = 'upsert'; ctx.payload = r; return b; },
    insert(r) { ctx.op = 'insert'; ctx.payload = r; return b; },
    update(p) { ctx.op = 'update'; ctx.payload = p; return b; },
    select() { return b; }, eq() { return b; },
    single() { return Promise.resolve(resolveRow()); },
    maybeSingle() { return Promise.resolve(resolveRow()); },
    order() { return Promise.resolve(resolveRow()); },
  };
  return { client: b, inserted };
}

// A resolver that resolves one domain, is ambiguous on another, and not-found on the rest.
const injectedResolver = (domain) => {
  if (domain === 'resolved.test') return { outcome: 'RESOLVED', organisationId: 'ORG-XYZ', provenance: { authorityVersion: '2026-01-01T00:00:00.000Z' } };
  if (domain === 'ambiguous.test') return { outcome: 'AMBIGUOUS', organisationId: null, candidates: ['ORG-A', 'ORG-B'], provenance: { reason: 'CONTESTED_DOMAIN' } };
  if (domain === 'invalid.test') return { outcome: 'INVALID', organisationId: null, provenance: { reason: 'INPUT_NOT_A_DOMAIN' } };
  return { outcome: 'NOT_FOUND', organisationId: null, provenance: { reason: 'NO_VERIFIED_DOMAIN_CLAIM' } };
};

describe('session populates organisation_id from the resolver — RESOLVED only', () => {
  test('RESOLVED → organisation_id + repository_authority_ref set; all others NULL', async () => {
    const { client, inserted } = routingClient();
    await runCollectionSession({
      runLabel: 'RESOLVE-TEST',
      domains: ['resolved.test', 'ambiguous.test', 'invalid.test', 'unknown.test'],
      adapter: demoAdapter,
      deps: { client, resolveOrganisation: injectedResolver, now: () => 'T' },
    });

    const byDomain = Object.fromEntries(inserted.signal_facts_demo.map(o => [o.domain, o]));

    // RESOLVED — linked, with a provenance snapshot marker.
    assert.equal(byDomain['resolved.test'].organisation_id, 'ORG-XYZ');
    assert.equal(byDomain['resolved.test'].repository_authority_ref, 'authority@2026-01-01T00:00:00.000Z');

    // Every non-RESOLVED outcome leaves organisation_id NULL — never a wrong assignment.
    for (const d of ['ambiguous.test', 'invalid.test', 'unknown.test']) {
      assert.equal(byDomain[d].organisation_id, null, `${d} must be unlinked`);
      assert.equal(byDomain[d].repository_authority_ref, null);
    }
    // The observations still persisted (resolution never blocks collection).
    assert.equal(inserted.signal_facts_demo.length, 4);
  });

  test('a resolver that throws never blocks collection (observation persists unlinked)', async () => {
    const { client, inserted } = routingClient();
    const result = await runCollectionSession({
      runLabel: 'RESOLVE-THROW',
      domains: ['resolved.test'],
      adapter: demoAdapter,
      deps: { client, resolveOrganisation: () => { throw new Error('resolver down'); }, now: () => 'T' },
    });
    assert.equal(result.counts.persisted, 1);
    assert.equal(inserted.signal_facts_demo[0].organisation_id, null);
  });
});
