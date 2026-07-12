'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const store = require('./event-store');

// Sequence-aware fake Supabase builder (thenable for list/limit queries).
function fakeClient(results) {
  const queue = Array.isArray(results) ? [...results] : [results];
  const calls = [];
  const next = () => (queue.length > 1 ? queue.shift() : queue[0]);
  const builder = {
    from(t) { calls.push(['from', t]); return builder; },
    insert(r) { calls.push(['insert', r]); return builder; },
    select(c) { calls.push(['select', c]); return builder; },
    eq(c, v) { calls.push(['eq', c, v]); return builder; },
    lte(c, v) { calls.push(['lte', c, v]); return builder; },
    order(...a) { calls.push(['order', ...a]); return builder; },
    limit(n) { calls.push(['limit', n]); return builder; },
    single() { calls.push(['single']); return Promise.resolve(next()); },
    maybeSingle() { calls.push(['maybeSingle']); return Promise.resolve(next()); },
    then(res, rej) { return Promise.resolve(next()).then(res, rej); },
  };
  return { client: builder, calls };
}

test('the store surface is append-only — no update or delete is exported', () => {
  assert.strictEqual(typeof store.recordEvent, 'function');
  assert.strictEqual(typeof store.listEventsForOrganisation, 'function');
  assert.strictEqual(typeof store.getEvent, 'function');
  assert.strictEqual(store.updateEvent, undefined);
  assert.strictEqual(store.deleteEvent, undefined);
  assert.strictEqual(store.removeEvent, undefined);
});

test('recordEvent — appends a validated Observation event, defaulting recorded_at', async () => {
  const { client, calls } = fakeClient({ data: { event_id: 'e1' }, error: null });
  const r = await store.recordEvent({
    subjectType: 'Observation', subjectId: 'obs-1', organisationId: 'ORG-ABC',
    occurredAt: '2026-07-01T00:00:00Z', repositoryAuthorityVersion: 'ra-v1', qualityModelVersion: 'DMARC-QM-v1.0',
  }, client);

  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls[0], ['from', 'events']);
  const row = calls[1][1][0];
  assert.strictEqual(row.subject_type, 'Observation');
  assert.strictEqual(row.organisation_id, 'ORG-ABC');
  assert.strictEqual(row.repository_authority_version, 'ra-v1');
  assert.strictEqual(row.quality_model_version, 'DMARC-QM-v1.0');
  assert.ok(row.recorded_at, 'recorded_at defaulted');
});

test('recordEvent — rejects an unadmitted subject_type (ObservationSession) before any write', async () => {
  const { client, calls } = fakeClient({ data: null, error: null });
  const r = await store.recordEvent({ subjectType: 'ObservationSession', subjectId: 's1', occurredAt: '2026-07-01T00:00:00Z' }, client);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not admitted/);
  assert.ok(!calls.some((c) => c[0] === 'insert'), 'no insert attempted for a rejected subject');
});

test('recordEvent — requires subjectId and occurredAt', async () => {
  const { client } = fakeClient({ data: null, error: null });
  assert.match((await store.recordEvent({ subjectType: 'Observation', occurredAt: '2026-07-01T00:00:00Z' }, client)).error, /subjectId is required/);
  assert.match((await store.recordEvent({ subjectType: 'Observation', subjectId: 'o1' }, client)).error, /occurredAt is required/);
});

test('listEventsForOrganisation — filters by org and bounds by asOf (valid-time projection)', async () => {
  const { client, calls } = fakeClient({ data: [{ event_id: 'e1' }], error: null });
  const r = await store.listEventsForOrganisation('ORG-ABC', { asOf: '2026-07-05T00:00:00Z', limit: 100 }, client);
  assert.strictEqual(r.ok, true);
  assert.ok(calls.some((c) => c[0] === 'eq' && c[1] === 'organisation_id' && c[2] === 'ORG-ABC'));
  assert.ok(calls.some((c) => c[0] === 'lte' && c[1] === 'occurred_at' && c[2] === '2026-07-05T00:00:00Z'));
  assert.ok(calls.some((c) => c[0] === 'order' && c[1] === 'occurred_at'));
});

test('listEventsForOrganisation — a missing org has no history by construction', async () => {
  const { client, calls } = fakeClient({ data: null, error: null });
  const r = await store.listEventsForOrganisation(null, {}, client);
  assert.deepStrictEqual(r, { ok: true, events: [] });
  assert.strictEqual(calls.length, 0, 'no query issued for a null org');
});
