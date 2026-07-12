'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { projectOrganisationHistory } = require('./organisation-history');
const emitters = require('../events/emitters');

// Fake client whose `events` reads return a scripted event stream, and whose
// per-signal observation reads return configured rows. Thenable so the
// event-store's list query (ends in .limit()) and per-signal reads resolve.
function fakeClient({ events = [], observationRows = {} } = {}) {
  const calls = [];
  let currentTable = null;
  const builder = {
    from(t) { calls.push(['from', t]); currentTable = t; return builder; },
    select(c) { calls.push(['select', c]); return builder; },
    insert(r) { calls.push(['insert', r]); return builder; },
    eq(c, v) { calls.push(['eq', c, v]); return builder; },
    lte(c, v) { calls.push(['lte', c, v]); return builder; },
    order(...a) { calls.push(['order', ...a]); return builder; },
    limit(n) { calls.push(['limit', n]); return builder; },
    single() { return Promise.resolve({ data: {}, error: null }); },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    then(res, rej) {
      const table = currentTable;
      const result = table === 'events'
        ? { data: events, error: null }
        : { data: observationRows[table] ?? [], error: null };
      return Promise.resolve(result).then(res, rej);
    },
  };
  return { client: builder, calls };
}

const ORG = 'ORG-HIST01';

test('projectOrganisationHistory — folds the event stream, resolving each subject through the registry', async () => {
  const events = [
    { event_id: 'e2', subject_type: 'RepositoryChange', subject_id: 'ra-2026-07-10', organisation_id: ORG, occurred_at: '2026-07-10T00:00:00Z', recorded_at: '2026-07-10T01:00:00Z', repository_authority_version: 'ra-2026-07-10', quality_model_version: null, metadata: { change: 'domain-reassignment' } },
    { event_id: 'e1', subject_type: 'Observation', subject_id: 'run-A', organisation_id: ORG, occurred_at: '2026-07-01T00:00:00Z', recorded_at: '2026-07-01T00:05:00Z', repository_authority_version: 'ra-2026-07-01', quality_model_version: 'DMARC-QM-v1.0', metadata: {} },
  ];
  const { client } = fakeClient({ events });

  const history = await projectOrganisationHistory(ORG, {
    client,
    resolvers: { resolveObservation: async (id) => ({ collectionRunId: id, observationCount: 3 }) },
  });

  assert.strictEqual(history.eventCount, 2);
  // Deterministic order: by occurred_at, so Observation (Jul 1) precedes RepositoryChange (Jul 10).
  assert.deepStrictEqual(history.entries.map((e) => e.subjectType), ['Observation', 'RepositoryChange']);
  // Observation resolved through the injected resolver.
  assert.strictEqual(history.entries[0].resolved, true);
  assert.deepStrictEqual(history.entries[0].subject, { collectionRunId: 'run-A', observationCount: 3 });
  assert.strictEqual(history.entries[0].qualityModelVersion, 'DMARC-QM-v1.0');
});

test('projectOrganisationHistory — unresolved subjects surface honestly, never fabricated', async () => {
  const events = [
    { event_id: 'e1', subject_type: 'RepositoryChange', subject_id: 'ra-x', organisation_id: ORG, occurred_at: '2026-07-10T00:00:00Z', recorded_at: '2026-07-10T00:00:00Z', repository_authority_version: 'ra-x', quality_model_version: null, metadata: {} },
  ];
  const { client } = fakeClient({ events });

  // No resolveRepositoryChange injected → the registry surfaces an honest reference.
  const history = await projectOrganisationHistory(ORG, { client });

  assert.strictEqual(history.unresolvedCount, 1);
  assert.strictEqual(history.entries[0].resolved, false);
  assert.strictEqual(history.entries[0].subject, null);
  assert.match(history.entries[0].reference.reason, /not yet materialised/);
});

test('projectOrganisationHistory — asOf is passed to the event stream (valid-time bound)', async () => {
  const { client, calls } = fakeClient({ events: [] });
  await projectOrganisationHistory(ORG, { client, asOf: '2026-07-05T00:00:00Z' });
  assert.ok(calls.some((c) => c[0] === 'lte' && c[1] === 'occurred_at' && c[2] === '2026-07-05T00:00:00Z'));
});

test('projectOrganisationHistory — a missing org has empty history by construction (no query)', async () => {
  const { client, calls } = fakeClient({ events: [] });
  const history = await projectOrganisationHistory(null, { client });
  assert.deepStrictEqual(history.entries, []);
  assert.strictEqual(history.eventCount, 0);
  assert.strictEqual(calls.length, 0);
});

test('projectOrganisationHistory — reproducible: same events -> identical projection', async () => {
  const events = [
    { event_id: 'eB', subject_type: 'Observation', subject_id: 'run-2', organisation_id: ORG, occurred_at: '2026-07-01T00:00:00Z', recorded_at: 'x', repository_authority_version: null, quality_model_version: null, metadata: {} },
    { event_id: 'eA', subject_type: 'Observation', subject_id: 'run-1', organisation_id: ORG, occurred_at: '2026-07-01T00:00:00Z', recorded_at: 'x', repository_authority_version: null, quality_model_version: null, metadata: {} },
  ];
  const r1 = await projectOrganisationHistory(ORG, { client: fakeClient({ events }).client, resolvers: { resolveObservation: async () => null } });
  const r2 = await projectOrganisationHistory(ORG, { client: fakeClient({ events }).client, resolvers: { resolveObservation: async () => null } });
  assert.deepStrictEqual(r1, r2);
  // Tie on occurred_at broken deterministically by event_id → eA before eB.
  assert.deepStrictEqual(r1.entries.map((e) => e.subjectId), ['run-1', 'run-2']);
});

// ── Emitters route through the sanctioned API only ────────────────────────────

test('emitObservationRecorded — emits an Observation event via the store', async () => {
  const { client, calls } = fakeClient({});
  await emitters.emitObservationRecorded({ organisationId: ORG, collectionRunId: 'run-A', occurredAt: '2026-07-01T00:00:00Z', repositoryAuthorityVersion: 'ra-1', qualityModelVersion: 'DMARC-QM-v1.0' }, client);
  const insert = calls.find((c) => c[0] === 'insert');
  assert.ok(insert, 'an insert was issued');
  assert.strictEqual(insert[1][0].subject_type, 'Observation');
  assert.strictEqual(insert[1][0].subject_id, 'run-A');
});

test('emitRepositoryChange — emits a RepositoryChange event with the new RA version', async () => {
  const { client, calls } = fakeClient({});
  await emitters.emitRepositoryChange({ organisationId: ORG, changeRef: 'ra-2026-07-10', occurredAt: '2026-07-10T00:00:00Z', repositoryAuthorityVersion: 'ra-2026-07-10', metadata: { change: 'merge' } }, client);
  const insert = calls.find((c) => c[0] === 'insert');
  assert.strictEqual(insert[1][0].subject_type, 'RepositoryChange');
  assert.strictEqual(insert[1][0].repository_authority_version, 'ra-2026-07-10');
});
