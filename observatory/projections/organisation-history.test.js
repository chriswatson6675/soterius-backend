'use strict';

// Sprint 11 — Organisation History projection. Deterministic, evidence-only,
// read-only. A fake client stores per-table rows and answers
// .from(table).select('*').eq('organisation_id', id) with the filtered rows —
// so the projection is exercised without a live DB.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildOrganisationHistory } = require('./organisation-history');

// Fake Supabase read client. `.eq` is the terminal await point (mirrors
// PostgREST builders being thenable after a filter).
function fakeClient(tables) {
  let ctx = {};
  return {
    from(t) { ctx = { table: t }; return this; },
    select() { return this; },
    eq(col, val) {
      const rows = (tables[ctx.table] || []).filter((r) => r[col] === val);
      return Promise.resolve({ data: rows, error: null });
    },
  };
}

// A canonical Observation row (payload + envelope) as persisted.
function obs(table, id, orgId, collector, collectedAt, runId, extra = {}) {
  return {
    id, domain: `${id}.example`, organisation_id: orgId,
    collector, collector_version: `${collector}@1.0.0`, collection_method: 'X',
    collection_programme_id: `prog-${collector}`, collection_run_id: runId,
    collected_at: collectedAt, collection_outcome: 'OBSERVED_PRESENT',
    created_at: '2026-instant', signal_version: 1, ...extra,
  };
}

const ORG = 'ORG-1';

describe('single Observation', () => {
  test('one row → one chronological entry, evidence-only', async () => {
    const client = fakeClient({ signal_facts_dnssec: [obs('signal_facts_dnssec', 'o1', ORG, 'dnssec', 'T1', 'run-1', { dns_ds_present: true, ds_records: [{ key_tag: 1 }] })] });
    const h = await buildOrganisationHistory(ORG, { client });
    assert.equal(h.observationCount, 1);
    assert.deepEqual(h.signalsObserved, ['dnssec']);
    const e = h.entries[0];
    assert.equal(e.observationId, 'o1');
    assert.equal(e.collector, 'dnssec');
    assert.equal(e.collectionRunId, 'run-1');
    assert.equal(e.collectionProgrammeId, 'prog-dnssec');
    assert.equal(e.collectedAt, 'T1');
    assert.equal(e.collectionOutcome, 'OBSERVED_PRESENT');
    // observed facts are the payload; envelope columns are NOT inside them
    assert.equal(e.observedFacts.dns_ds_present, true);
    assert.deepEqual(e.observedFacts.ds_records, [{ key_tag: 1 }]);
    for (const k of ['collection_run_id', 'organisation_id', 'collector', 'collection_outcome', 'id']) {
      assert.equal(k in e.observedFacts, false, `observedFacts must not contain envelope key ${k}`);
    }
  });
});

describe('no Quality Model / score / Trust Profile output', () => {
  test('entries and observedFacts carry no interpreted value', async () => {
    const client = fakeClient({ signal_facts_spf: [obs('signal_facts_spf', 'o1', ORG, 'spf', 'T1', 'run-1', { spf_present: true, spf_mechanism: '-all' })] });
    const h = await buildOrganisationHistory(ORG, { client });
    const forbidden = ['score', 'final_score', 'primary_label', 'quality_version', 'risk_band', 'grade', 'trustProfile'];
    for (const e of h.entries) {
      for (const k of forbidden) {
        assert.equal(k in e, false);
        assert.equal(k in e.observedFacts, false);
      }
    }
  });
});

describe('multiple Observations, signals, and Collection Runs', () => {
  test('multiple observations of one signal', async () => {
    const client = fakeClient({ signal_facts_dnssec: [
      obs('signal_facts_dnssec', 'a', ORG, 'dnssec', 'T2', 'run-2'),
      obs('signal_facts_dnssec', 'b', ORG, 'dnssec', 'T1', 'run-1'),
    ] });
    const h = await buildOrganisationHistory(ORG, { client });
    assert.equal(h.observationCount, 2);
    assert.deepEqual(h.entries.map((e) => e.observationId), ['b', 'a']); // chronological
  });

  test('multiple signals across multiple runs, chronologically merged', async () => {
    const client = fakeClient({
      signal_facts_dnssec: [obs('signal_facts_dnssec', 'd1', ORG, 'dnssec', 'T3', 'run-3')],
      signal_facts_spf: [obs('signal_facts_spf', 's1', ORG, 'spf', 'T1', 'run-1')],
      signal_tls_v1: [obs('signal_tls_v1', 't1', ORG, 'tls', 'T2', 'run-2', { evidence: { negotiated_version: 'TLSv1.3' } })],
    });
    const h = await buildOrganisationHistory(ORG, { client });
    assert.equal(h.observationCount, 3);
    assert.deepEqual(h.entries.map((e) => e.collectedAt), ['T1', 'T2', 'T3']);
    assert.deepEqual(h.signalsObserved, ['dnssec', 'spf', 'tls']);
    assert.equal(h.firstObservedAt, 'T1');
    assert.equal(h.lastObservedAt, 'T3');
    // TLS evidence JSONB preserved in observedFacts
    assert.deepEqual(h.entries[1].observedFacts.evidence, { negotiated_version: 'TLSv1.3' });
  });
});

describe('deterministic ordering', () => {
  test('same collectedAt → stable tie-break by collector then observationId', async () => {
    const client = fakeClient({
      signal_facts_spf: [obs('signal_facts_spf', 'z', ORG, 'spf', 'T1', 'run-1')],
      signal_facts_dmarc: [obs('signal_facts_dmarc', 'a', ORG, 'dmarc', 'T1', 'run-1')],
    });
    const h1 = await buildOrganisationHistory(ORG, { client });
    const h2 = await buildOrganisationHistory(ORG, { client });
    assert.deepEqual(h1, h2);                                   // deterministic
    assert.deepEqual(h1.entries.map((e) => e.collector), ['dmarc', 'spf']); // tie-break by collector
  });
});

describe('only linked Observations appear; NULL excluded', () => {
  test('rows for other organisations and NULL organisation_id are excluded', async () => {
    const client = fakeClient({ signal_facts_dnssec: [
      obs('signal_facts_dnssec', 'mine', ORG, 'dnssec', 'T1', 'run-1'),
      obs('signal_facts_dnssec', 'theirs', 'ORG-2', 'dnssec', 'T1', 'run-1'),
      obs('signal_facts_dnssec', 'unlinked', null, 'dnssec', 'T1', 'run-1'),
    ] });
    const h = await buildOrganisationHistory(ORG, { client });
    assert.deepEqual(h.entries.map((e) => e.observationId), ['mine']);
  });

  test('a NULL / missing organisation_id argument yields empty history', async () => {
    const client = fakeClient({ signal_facts_dnssec: [obs('signal_facts_dnssec', 'x', null, 'dnssec', 'T1', 'run-1')] });
    assert.equal((await buildOrganisationHistory(null, { client })).observationCount, 0);
    assert.equal((await buildOrganisationHistory(undefined, { client })).observationCount, 0);
  });
});

describe('Organisation with no Observations', () => {
  test('empty history, not an error', async () => {
    const h = await buildOrganisationHistory('ORG-EMPTY', { client: fakeClient({}) });
    assert.deepEqual(h, { organisationId: 'ORG-EMPTY', observationCount: 0, signalsObserved: [], firstObservedAt: null, lastObservedAt: null, entries: [] });
  });
});

describe('immutability & reproducibility', () => {
  test('projection never mutates the underlying rows', async () => {
    const rows = [obs('signal_facts_dnssec', 'o1', ORG, 'dnssec', 'T1', 'run-1', { dns_ds_present: true })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    const client = fakeClient({ signal_facts_dnssec: rows });
    await buildOrganisationHistory(ORG, { client });
    assert.deepEqual(rows, snapshot); // read-only — evidence untouched
  });

  test('late-arriving Observation automatically extends history on re-projection', async () => {
    const tables = { signal_facts_dnssec: [obs('signal_facts_dnssec', 'o1', ORG, 'dnssec', 'T1', 'run-1')] };
    const client = fakeClient(tables);
    const before = await buildOrganisationHistory(ORG, { client });
    assert.equal(before.observationCount, 1);

    // A new Observation arrives (a later Collection Run persists a new row).
    tables.signal_facts_dnssec.push(obs('signal_facts_dnssec', 'o2', ORG, 'dnssec', 'T2', 'run-2'));

    const after = await buildOrganisationHistory(ORG, { client });
    assert.equal(after.observationCount, 2);                          // history extended, no rebuild/migration
    assert.deepEqual(after.entries.map((e) => e.observationId), ['o1', 'o2']);
    assert.equal(after.lastObservedAt, 'T2');
  });
});
