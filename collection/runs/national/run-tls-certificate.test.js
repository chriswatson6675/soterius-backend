'use strict';

// Sprint 12 (completion) — TLS/Certificate dual-write runner. One injected TLS
// session per domain feeds two canonical Observations (signal_tls_v1 +
// signal_certificate_v1) under two Collection Runs, org resolved once. Exercised
// with a fake session + fake client (no real handshake, no DB).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runNationalTlsCertificate } = require('./run-national');

// A fake TLS "session" carrying the fields the extractors read.
const fakeSession = (domain) => ({
  domain,
  endpoint_state: 'RESPONSE_OBSERVED',
  negotiated_version: 'TLSv1.3',
  certificate_present: 'CERTIFICATE_PRESENTED',
  tls_verification_result: 'CHAIN_VERIFIED',
  collected_at: 'T',
});
// Stand-in extractors that just echo the relevant slice (real ones are untouched).
const extractTls = (s) => ({ endpoint_state: s.endpoint_state, negotiated_version: s.negotiated_version, collected_at: s.collected_at, evidence_tag: 'tls' });
const extractCert = (s) => ({ endpoint_state: s.endpoint_state, certificate_present: s.certificate_present, tls_verification_result: s.tls_verification_result, collected_at: s.collected_at, evidence_tag: 'cert' });

// Concurrency-safe fake: each .from() returns a FRESH builder with its own ctx
// (the real PostgREST client does the same), so interleaved concurrent queries
// never clobber each other.
function fakeClient() {
  const inserted = { collection_programmes: [], collection_runs: [], signal_tls_v1: [], signal_certificate_v1: [], events: [] };
  let runSeq = 0, progSeq = 0, obsSeq = 0, eventSeq = 0;
  function makeBuilder(table) {
    const ctx = { table };
    function res() {
      const { op, payload } = ctx;
      if (table === 'collection_programmes') { const id = `prog-${++progSeq}`; const r = { id, ...payload[0] }; inserted.collection_programmes.push(r); return { data: r, error: null }; }
      if (table === 'collection_runs' && op === 'insert') { const id = `run-${++runSeq}`; const r = { id, status: 'RUNNING', ...payload[0] }; inserted.collection_runs.push(r); return { data: r, error: null }; }
      if (table === 'collection_runs' && op === 'update') return { data: { id: 'run-x', ...payload }, error: null };
      // Real Supabase's .insert([row]).select('id').single() returns the
      // inserted row's id when the insert succeeds — mirrored here so tests
      // exercise the same shape the production client returns.
      if (table === 'signal_tls_v1') { const id = `tls-obs-${++obsSeq}`; inserted.signal_tls_v1.push({ id, ...payload[0] }); return { data: { id }, error: null }; }
      if (table === 'signal_certificate_v1') { const id = `cert-obs-${++obsSeq}`; inserted.signal_certificate_v1.push({ id, ...payload[0] }); return { data: { id }, error: null }; }
      if (table === 'events') { const event_id = `event-${++eventSeq}`; const r = { event_id, ...payload[0] }; inserted.events.push(r); return { data: r, error: null }; }
      return { data: null, error: { message: 'unrouted ' + table } };
    }
    const b = {
      upsert(r) { ctx.op = 'upsert'; ctx.payload = r; return b; },
      insert(r) { ctx.op = 'insert'; ctx.payload = r; return b; },
      update(p) { ctx.op = 'update'; ctx.payload = p; return b; },
      select() { return b; }, eq() { return b; },
      single() { return Promise.resolve(res()); }, maybeSingle() { return Promise.resolve(res()); }, order() { return Promise.resolve(res()); },
      then(onF, onR) { try { onF(res()); } catch (e) { if (onR) onR(e); } },
    };
    return b;
  }
  return { client: { from: (t) => makeBuilder(t) }, inserted };
}

const RESOLVE = (d) => d === 'linked.test'
  ? { outcome: 'RESOLVED', organisationId: 'ORG-1', provenance: { authorityVersion: 'V' } }
  : { outcome: 'NOT_FOUND', organisationId: null, provenance: {} };

const run = (client) => runNationalTlsCertificate({
  domains: ['linked.test', 'unlinked.test'],
  concurrency: 2,
  deps: {
    client,
    collectSession: async (d) => fakeSession(d),
    extractTls, extractCert,
    resolveOrganisation: RESOLVE,
    now: () => 'T',
  },
});

describe('TLS/Certificate dual-write runner', () => {
  test('both tables receive a canonical Observation per domain', async () => {
    const { client, inserted } = fakeClient();
    const result = await run(client);
    assert.equal(inserted.signal_tls_v1.length, 2);
    assert.equal(inserted.signal_certificate_v1.length, 2);
    assert.equal(result.counts.tlsPersisted, 2);
    assert.equal(result.counts.certPersisted, 2);
    // two distinct programmes + two distinct runs
    assert.equal(inserted.collection_programmes.length, 2);
    assert.equal(inserted.collection_runs.length, 2);
    assert.notEqual(result.tls.run.id, result.certificate.run.id);
  });

  test('each Observation carries the canonical envelope + its own run', async () => {
    const { client, inserted } = fakeClient();
    const result = await run(client);
    const tls = inserted.signal_tls_v1.find((r) => r.domain === 'linked.test');
    const cert = inserted.signal_certificate_v1.find((r) => r.domain === 'linked.test');
    assert.equal(tls.collector, 'tls');
    assert.equal(cert.collector, 'certificate');
    assert.equal(tls.collection_run_id, result.tls.run.id);
    assert.equal(cert.collection_run_id, result.certificate.run.id);
    assert.equal(tls.collection_outcome, 'OBSERVED_PRESENT');
    assert.equal(cert.collection_outcome, 'OBSERVED_PRESENT');
    // full evidence preserved in the JSONB evidence column
    assert.equal(tls.evidence.evidence_tag, 'tls');
    assert.equal(cert.evidence.evidence_tag, 'cert');
  });

  test('organisation resolved once, applied to BOTH writes; unresolved stays NULL', async () => {
    const { client, inserted } = fakeClient();
    await run(client);
    const tlsLinked = inserted.signal_tls_v1.find((r) => r.domain === 'linked.test');
    const certLinked = inserted.signal_certificate_v1.find((r) => r.domain === 'linked.test');
    assert.equal(tlsLinked.organisation_id, 'ORG-1');
    assert.equal(certLinked.organisation_id, 'ORG-1');           // same org on both tables

    const tlsUnlinked = inserted.signal_tls_v1.find((r) => r.domain === 'unlinked.test');
    assert.equal(tlsUnlinked.organisation_id, null);
  });

  test('empty domains rejected', async () => {
    await assert.rejects(() => runNationalTlsCertificate({ domains: [] }), /non-empty array/);
  });
});

describe('constitutional Event emission (F4 — OBS-CONST-001 §4)', () => {
  test('each domain emits TWO ObservationRecorded events — one for TLS, one for Certificate, each under its own run', async () => {
    const { client, inserted } = fakeClient();
    const result = await run(client);
    assert.equal(inserted.events.length, 4); // 2 domains × (TLS + Certificate)

    const bySubject = (runId) => inserted.events.filter((e) => e.subject_id === runId);
    const tlsEvents = bySubject(result.tls.run.id);
    const certEvents = bySubject(result.certificate.run.id);
    assert.equal(tlsEvents.length, 2);
    assert.equal(certEvents.length, 2);

    for (const ev of [...tlsEvents, ...certEvents]) {
      assert.equal(ev.subject_type, 'Observation');
      assert.equal(ev.quality_model_version, null, 'no Quality Model version — Events are observational, never interpretive');
      assert.ok(ev.metadata && ev.metadata.domain && ev.metadata.observationId, 'metadata is descriptive only');
      assert.equal(JSON.stringify(ev).match(/score|band|verdict|trust/i), null);
    }
    // Each signal's Event correctly names itself.
    assert.ok(tlsEvents.every((e) => e.metadata.signal === 'tls'));
    assert.ok(certEvents.every((e) => e.metadata.signal === 'certificate'));
  });

  test('organisation_id on both Events matches the once-resolved Organisation; null when unresolved (Unknown ≠ Absent)', async () => {
    const { client, inserted } = fakeClient();
    await run(client);
    const linkedEvents = inserted.events.filter((e) => e.metadata.domain === 'linked.test');
    assert.equal(linkedEvents.length, 2);
    assert.ok(linkedEvents.every((e) => e.organisation_id === 'ORG-1'));

    const unlinkedEvents = inserted.events.filter((e) => e.metadata.domain === 'unlinked.test');
    assert.equal(unlinkedEvents.length, 2);
    assert.ok(unlinkedEvents.every((e) => e.organisation_id === null));
  });

  test('a Certificate write failure does not suppress the TLS Event, and vice versa', async () => {
    const { client, inserted } = fakeClient();
    // Wrap the client so ONLY the certificate table errors on insert.
    const certInsertDenied = {
      select() {
        return { single() { return Promise.resolve({ data: null, error: { message: 'cert insert denied' } }); } };
      },
    };
    const partialFailClient = {
      from(t) {
        if (t !== 'signal_certificate_v1') return client.from(t);
        return { insert() { return certInsertDenied; } };
      },
    };
    const result = await runNationalTlsCertificate({
      domains: ['linked.test'], concurrency: 1,
      deps: {
        client: partialFailClient,
        collectSession: async (d) => fakeSession(d),
        extractTls, extractCert,
        resolveOrganisation: RESOLVE,
        now: () => 'T',
      },
    });
    assert.equal(result.counts.tlsPersisted, 1);
    assert.equal(result.counts.certPersisted, 0);
    // The TLS Event was still emitted despite the Certificate write failing.
    assert.equal(inserted.events.length, 1);
    assert.equal(inserted.events[0].metadata.signal, 'tls');
  });

  test('an insert that "succeeds" with a null id (an unusual but tolerated client shape) never crashes the run or the sibling write', async () => {
    // Regression guard: emitting must never re-derive the observation id inside
    // a catch block — doing so once caused a null-id insert on ONE table to
    // throw past the OTHER table's write entirely (root-caused during F4 TLS/
    // Certificate wiring). Both signal tables here report success with data:null.
    const nullIdInsert = {
      select() {
        return { single() { return Promise.resolve({ data: null, error: null }); } };
      },
    };
    const nullIdClient = {
      from(t) {
        if (t !== 'signal_tls_v1' && t !== 'signal_certificate_v1') return fakeClient().client.from(t);
        return { insert() { return nullIdInsert; } };
      },
    };
    // Reuse one real fake for the programme/run/event plumbing, only override the two signal tables.
    const { client: base, inserted } = fakeClient();
    const mixedClient = { from: (t) => (t === 'signal_tls_v1' || t === 'signal_certificate_v1' ? nullIdClient.from(t) : base.from(t)) };

    const result = await runNationalTlsCertificate({
      domains: ['linked.test'], concurrency: 1,
      deps: {
        client: mixedClient,
        collectSession: async (d) => fakeSession(d),
        extractTls, extractCert,
        resolveOrganisation: RESOLVE,
        now: () => 'T',
      },
    });
    // Both writes still count as persisted (error was null on each), and BOTH
    // Events were attempted — neither was skipped because of the other.
    assert.equal(result.counts.tlsPersisted, 1);
    assert.equal(result.counts.certPersisted, 1);
    assert.equal(inserted.events.length, 2);
    assert.ok(inserted.events.every((e) => e.metadata.observationId === null));
  });
});
