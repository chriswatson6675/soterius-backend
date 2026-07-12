'use strict';

// Sprint 7 — end-to-end DNSSEC operational integration.
// Exercises the REAL orchestration + REAL registry builders + REAL observation
// builder against a routing fake Supabase client (no live DB, no network). Proves
// the complete ownership chain: Programme → Run → Observation, and that a scored
// Observation still feeds the (unchanged) Quality Model.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runDnssecCollectionSession } = require('./dnssec-collection-session');
const { scoreDnssecQuality } = require('../../../observatory/quality/dnssec-quality');

// ── Fixtures ─────────────────────────────────────────────────────────────────

const anchored = {
  dns_ds_present: true, ds_collection_error: null,
  ds_records: [{ key_tag: 1, algorithm: 13, digest_type: 2, digest: 'ab' }],
  ds_record_count: 1, ds_algorithms: [13], ds_digest_types: [2], ds_key_tags: [1],
  dns_dnskey_present: true, dnskey_collection_error: null,
  dnskey_records: [{ flags: 257, protocol: 3, algorithm: 13, public_key: 'k' }],
  dnskey_record_count: 1, dnskey_ksk_count: 1, dnskey_zsk_count: 0, dnskey_other_flags_count: 0,
  dnskey_algorithms: [13], dnskey_key_tags: [1],
};
const unsigned = {
  dns_ds_present: false, ds_collection_error: null, ds_records: [], ds_record_count: 0,
  ds_algorithms: [], ds_digest_types: [], ds_key_tags: [],
  dns_dnskey_present: false, dnskey_collection_error: null, dnskey_records: [], dnskey_record_count: 0,
  dnskey_ksk_count: 0, dnskey_zsk_count: 0, dnskey_other_flags_count: 0, dnskey_algorithms: [], dnskey_key_tags: [],
};
const timeout = {
  dns_ds_present: null, ds_collection_error: 'DNS_TIMEOUT', ds_records: [], ds_record_count: null,
  ds_algorithms: [], ds_digest_types: [], ds_key_tags: [],
  dns_dnskey_present: null, dnskey_collection_error: 'DNS_TIMEOUT', dnskey_records: [], dnskey_record_count: null,
  dnskey_ksk_count: null, dnskey_zsk_count: null, dnskey_other_flags_count: null, dnskey_algorithms: [], dnskey_key_tags: [],
};

const FACTS = { 'anchored.test': anchored, 'unsigned.test': unsigned, 'timeout.test': timeout };
const fakeCollect = async (domain) => FACTS[domain];

// ── Routing fake Supabase client ─────────────────────────────────────────────
// One client instance backs the whole session; it captures every inserted row so
// the ownership chain can be asserted after the run. Routes results by table+op.

function routingClient() {
  const inserted = { collection_programmes: [], collection_runs: [], signal_facts_dnssec: [] };
  let obsSeq = 0;
  let ctx = {};

  function resolve() {
    const { table, op, payload } = ctx;
    if (table === 'collection_programmes' && op === 'upsert') {
      const row = { id: 'prog-1', ...payload[0] };
      inserted.collection_programmes.push(row);
      return { data: row, error: null };
    }
    if (table === 'collection_runs' && op === 'insert') {
      const row = { id: 'run-1', status: 'RUNNING', ...payload[0] };
      inserted.collection_runs.push(row);
      return { data: row, error: null };
    }
    if (table === 'collection_runs' && op === 'update') {
      return { data: { id: 'run-1', ...payload }, error: null };
    }
    if (table === 'signal_facts_dnssec' && op === 'insert') {
      const id = `obs-${++obsSeq}`;
      inserted.signal_facts_dnssec.push({ id, ...payload[0] });
      return { data: { id }, error: null };
    }
    return { data: null, error: { message: `unrouted ${table}/${op}` } };
  }

  const builder = {
    from(t)   { ctx = { table: t }; return builder; },
    upsert(r) { ctx.op = 'upsert'; ctx.payload = r; return builder; },
    insert(r) { ctx.op = 'insert'; ctx.payload = r; return builder; },
    update(p) { ctx.op = 'update'; ctx.payload = p; return builder; },
    select()  { return builder; },
    eq()      { return builder; },
    single()  { return Promise.resolve(resolve()); },
    maybeSingle() { return Promise.resolve(resolve()); },
    order()   { return Promise.resolve(resolve()); },
  };
  return { client: builder, inserted };
}

// Stub resolver keeps these orchestration tests hermetic (no Repository Authority
// dataset load). Organisation resolution itself is covered in resolve.test.js.
const STUB_RESOLVE = () => ({ outcome: 'NOT_FOUND' });

const opts = (extra = {}) => ({
  runLabel: 'NOB-DNSSEC-TEST',
  domains: ['anchored.test', 'unsigned.test', 'timeout.test'],
  ...extra,
  deps: { collect: fakeCollect, resolveOrganisation: STUB_RESOLVE, now: () => '2026-01-01T00:00:00.000Z', ...(extra.deps || {}) },
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('end-to-end ownership chain: Programme → Run → Observation', () => {
  test('a Collection Programme exists (created idempotently as NATIONAL/dnssec)', async () => {
    const { client, inserted } = routingClient();
    const result = await runDnssecCollectionSession(opts({ deps: { collect: fakeCollect, client, now: () => 'T' } }));
    assert.equal(result.programme.id, 'prog-1');
    assert.equal(inserted.collection_programmes[0].kind, 'NATIONAL');
    assert.equal(inserted.collection_programmes[0].signal, 'dnssec');
    assert.equal(inserted.collection_programmes[0].programme_key, 'national-dnssec');
  });

  test('a Collection Run exists, owned by the programme', async () => {
    const { client, inserted } = routingClient();
    const result = await runDnssecCollectionSession(opts({ deps: { collect: fakeCollect, client, now: () => 'T' } }));
    assert.equal(result.run.id, 'run-1');
    assert.equal(inserted.collection_runs[0].programme_id, 'prog-1');
    assert.equal(inserted.collection_runs[0].run_label, 'NOB-DNSSEC-TEST');
  });

  test('one Run owns many Observations — every Observation carries the same run+programme', async () => {
    const { client, inserted } = routingClient();
    await runDnssecCollectionSession(opts({ deps: { collect: fakeCollect, client, now: () => 'T' } }));
    const obs = inserted.signal_facts_dnssec;
    assert.equal(obs.length, 3);
    for (const o of obs) {
      assert.equal(o.collection_run_id, 'run-1');
      assert.equal(o.collection_programme_id, 'prog-1');
      assert.equal(o.collector, 'dnssec');
    }
    // distinct domains under the one run
    assert.deepEqual(obs.map(o => o.domain).sort(), ['anchored.test', 'timeout.test', 'unsigned.test']);
  });
});

describe('every Observation has immutable identity, provenance, ownership, truthful outcome', () => {
  test('provenance + ownership + truthful collection outcome per domain', async () => {
    const { client, inserted } = routingClient();
    await runDnssecCollectionSession(opts({ deps: { collect: fakeCollect, client, now: () => 'T' } }));
    const byDomain = Object.fromEntries(inserted.signal_facts_dnssec.map(o => [o.domain, o]));

    // provenance (immutable once written)
    for (const o of Object.values(byDomain)) {
      assert.equal(o.collector_version, 'dnssec-collector@1.0.0');
      assert.equal(o.collection_method, 'DoH:cloudflare-dns.com');
      assert.equal(o.collected_at, 'T');
      assert.equal(o.organisation_id, null); // nullable by contract
    }
    // truthful collection outcome — the whole point of Sprints 3/6
    assert.equal(byDomain['anchored.test'].collection_outcome, 'OBSERVED_PRESENT');
    assert.equal(byDomain['unsigned.test'].collection_outcome, 'OBSERVED_ABSENT');
    assert.equal(byDomain['timeout.test'].collection_outcome, 'NOT_OBSERVED'); // never ABSENT
  });

  test('raw evidence and observed facts are preserved in the persisted row', async () => {
    const { client, inserted } = routingClient();
    await runDnssecCollectionSession(opts({ deps: { collect: fakeCollect, client, now: () => 'T' } }));
    const anchoredRow = inserted.signal_facts_dnssec.find(o => o.domain === 'anchored.test');
    assert.deepEqual(anchoredRow.ds_records, anchored.ds_records);       // raw evidence
    assert.deepEqual(anchoredRow.dnskey_key_tags, anchored.dnskey_key_tags); // observed facts
    // nothing interpreted
    assert.equal('final_score' in anchoredRow, false);
    assert.equal('primary_label' in anchoredRow, false);
  });
});

describe('run lifecycle and result accounting', () => {
  test('the run is transitioned RUNNING → COMPLETED with counts', async () => {
    const { client } = routingClient();
    const result = await runDnssecCollectionSession(opts({ deps: { collect: fakeCollect, client, now: () => 'T' } }));
    assert.equal(result.run.status, 'COMPLETED');
    assert.deepEqual(result.counts, { total: 3, persisted: 3, failed: 0 });
  });

  test('a single domain collection failure is recorded without failing the run', async () => {
    const { client } = routingClient();
    const collect = async (d) => { if (d === 'unsigned.test') throw new Error('DoH exploded'); return FACTS[d]; };
    const result = await runDnssecCollectionSession(opts({ deps: { collect, client, now: () => 'T' } }));
    assert.equal(result.counts.failed, 1);
    assert.equal(result.counts.persisted, 2);
    assert.ok(result.observations.find(o => o.domain === 'unsigned.test').error);
  });
});

describe('Quality Model still reads the persisted Observation unchanged', () => {
  test('a persisted anchored Observation scores 100 through the unchanged QM', async () => {
    const { client, inserted } = routingClient();
    await runDnssecCollectionSession(opts({ deps: { collect: fakeCollect, client, now: () => 'T' } }));
    const anchoredRow = inserted.signal_facts_dnssec.find(o => o.domain === 'anchored.test');
    // The QM reads the full persisted row (envelope + payload) and is unaffected.
    assert.equal(scoreDnssecQuality(anchoredRow).score, 100);
    assert.equal(scoreDnssecQuality(inserted.signal_facts_dnssec.find(o => o.domain === 'unsigned.test')).score, 0);
    assert.equal(scoreDnssecQuality(inserted.signal_facts_dnssec.find(o => o.domain === 'timeout.test')).scored, false);
  });
});
