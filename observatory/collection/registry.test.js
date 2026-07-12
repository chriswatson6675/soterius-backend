'use strict';

// Sprint 5 — Collection Programme / Run registry.
// Pure helpers are tested directly; persistence is tested against an injected
// fake Supabase client (no live DB), mirroring infra/database.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  PROGRAMME_KINDS, RUN_STATUSES, RUN_TRANSITIONS,
  isValidRunTransition, isTerminalRunStatus, kindContributesToHistory,
  buildProgrammeRow, buildRunRow,
  upsertProgramme, getProgrammeByKey, openRun, transitionRun, getRun, listRunsForProgramme,
} = require('./registry');

// Fake Supabase query-builder chain. Records every call; resolves at the
// terminal method (.single()/.maybeSingle()/.order()) with the configured result.
function fakeClient(result) {
  const calls = [];
  const builder = {
    from(t)        { calls.push(['from', t]);          return builder; },
    insert(r)      { calls.push(['insert', r]);         return builder; },
    upsert(r, o)   { calls.push(['upsert', r, o]);      return builder; },
    update(p)      { calls.push(['update', p]);         return builder; },
    select(c)      { calls.push(['select', c]);         return builder; },
    eq(col, val)   { calls.push(['eq', col, val]);      return builder; },
    order(...a)    { calls.push(['order', ...a]);       return Promise.resolve(result); },
    single()       { calls.push(['single']);            return Promise.resolve(result); },
    maybeSingle()  { calls.push(['maybeSingle']);       return Promise.resolve(result); },
  };
  return { client: builder, calls };
}

// ── Pure vocabulary / helpers ────────────────────────────────────────────────

describe('run lifecycle transitions', () => {
  test('legal transitions', () => {
    assert.ok(isValidRunTransition('PENDING', 'RUNNING'));
    assert.ok(isValidRunTransition('RUNNING', 'COMPLETED'));
    assert.ok(isValidRunTransition('RUNNING', 'FAILED'));
    assert.ok(isValidRunTransition('RUNNING', 'ABANDONED'));
    assert.ok(isValidRunTransition('PENDING', 'ABANDONED'));
  });

  test('terminal states are truly terminal — no outgoing transitions', () => {
    for (const terminal of ['COMPLETED', 'FAILED', 'ABANDONED']) {
      assert.deepEqual(RUN_TRANSITIONS[terminal], []);
      for (const to of RUN_STATUSES) {
        assert.equal(isValidRunTransition(terminal, to), false);
      }
      assert.ok(isTerminalRunStatus(terminal));
    }
  });

  test('illegal transitions rejected', () => {
    assert.equal(isValidRunTransition('RUNNING', 'PENDING'), false);
    assert.equal(isValidRunTransition('PENDING', 'COMPLETED'), false); // must pass through RUNNING
    assert.equal(isValidRunTransition('COMPLETED', 'RUNNING'), false);
  });
});

describe('kindContributesToHistory — Engineering Validation carve-out', () => {
  test('only ENGINEERING_VALIDATION is excluded from history', () => {
    for (const kind of PROGRAMME_KINDS) {
      assert.equal(kindContributesToHistory(kind), kind !== 'ENGINEERING_VALIDATION');
    }
  });
});

describe('buildProgrammeRow', () => {
  test('valid input produces a complete row with kind-derived history flag', () => {
    const row = buildProgrammeRow({ key: 'national-tls', name: 'National TLS', kind: 'NATIONAL', signal: 'tls' });
    assert.equal(row.programme_key, 'national-tls');
    assert.equal(row.signal, 'tls');
    assert.equal(row.contributes_to_history, true);
    assert.equal(row.status, 'ACTIVE');
  });

  test('ENGINEERING_VALIDATION defaults contributes_to_history to false', () => {
    const row = buildProgrammeRow({ key: 'engineering-validation', name: 'Engineering Validation', kind: 'ENGINEERING_VALIDATION' });
    assert.equal(row.contributes_to_history, false);
    assert.equal(row.signal, null);
  });

  test('explicit contributesToHistory override is honoured', () => {
    const row = buildProgrammeRow({ key: 'x', name: 'X', kind: 'ENGINEERING_VALIDATION', contributesToHistory: true });
    assert.equal(row.contributes_to_history, true);
  });

  test('invalid kind / missing fields throw', () => {
    assert.throws(() => buildProgrammeRow({ key: 'x', name: 'X', kind: 'BOGUS' }), /invalid programme kind/);
    assert.throws(() => buildProgrammeRow({ name: 'X', kind: 'NATIONAL' }), /programme key is required/);
    assert.throws(() => buildProgrammeRow({ key: 'x', kind: 'NATIONAL' }), /programme name is required/);
  });
});

describe('buildRunRow', () => {
  test('valid input opens a non-terminal run with completed_at null', () => {
    const row = buildRunRow({ programmeId: 'p1', runLabel: 'NOB-TLS-001' }, '2026-01-01T00:00:00.000Z');
    assert.equal(row.programme_id, 'p1');
    assert.equal(row.run_label, 'NOB-TLS-001');
    assert.equal(row.status, 'RUNNING');
    assert.equal(row.started_at, '2026-01-01T00:00:00.000Z');
    assert.equal(row.completed_at, null);
    assert.deepEqual(row.metadata, {});
  });

  test('cannot open a run directly in a terminal state', () => {
    assert.throws(() => buildRunRow({ programmeId: 'p1', runLabel: 'x', status: 'COMPLETED' }),
      /may not be opened directly in a terminal state/);
  });

  test('missing programmeId / runLabel throw', () => {
    assert.throws(() => buildRunRow({ runLabel: 'x' }), /programmeId is required/);
    assert.throws(() => buildRunRow({ programmeId: 'p1' }), /runLabel is required/);
  });
});

// ── Persistence (fake client) ────────────────────────────────────────────────

describe('upsertProgramme — idempotent create-or-return by programme_key', () => {
  test('upserts onConflict programme_key and returns the row', async () => {
    const row = { id: 'prog-1', programme_key: 'national-tls', kind: 'NATIONAL' };
    const { client, calls } = fakeClient({ data: row, error: null });

    const result = await upsertProgramme({ key: 'national-tls', name: 'National TLS', kind: 'NATIONAL', signal: 'tls' }, client);

    assert.deepEqual(result, { success: true, programme: row });
    assert.deepEqual(calls[0], ['from', 'collection_programmes']);
    assert.equal(calls[1][0], 'upsert');
    assert.deepEqual(calls[1][2], { onConflict: 'programme_key' });
  });

  test('surfaces a Supabase error without throwing', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    const result = await upsertProgramme({ key: 'x', name: 'X', kind: 'NATIONAL' }, client);
    assert.deepEqual(result, { success: false, error: 'boom' });
  });

  test('an invalid kind is rejected before any DB call', async () => {
    const { client, calls } = fakeClient({ data: null, error: null });
    const result = await upsertProgramme({ key: 'x', name: 'X', kind: 'BOGUS' }, client);
    assert.equal(result.success, false);
    assert.match(result.error, /invalid programme kind/);
    assert.equal(calls.length, 0); // never reached the client
  });
});

describe('openRun — a programme owns many runs, each with fresh immutable identity', () => {
  test('inserts a run under a programme and returns it with its assigned id', async () => {
    const run = { id: 'run-1', programme_id: 'prog-1', run_label: 'NOB-TLS-001', status: 'RUNNING' };
    const { client, calls } = fakeClient({ data: run, error: null });

    const result = await openRun({ programmeId: 'prog-1', runLabel: 'NOB-TLS-001' }, client);

    assert.deepEqual(result, { success: true, run });
    assert.deepEqual(calls[0], ['from', 'collection_runs']);
    assert.equal(calls[1][0], 'insert');
    // the inserted row carries the programme ownership and no id (DB assigns it)
    assert.equal(calls[1][1][0].programme_id, 'prog-1');
    assert.equal('id' in calls[1][1][0], false);
  });

  test('two runs opened under the same programme are independent inserts (owns-many)', async () => {
    const a = fakeClient({ data: { id: 'run-a', programme_id: 'prog-1' }, error: null });
    const b = fakeClient({ data: { id: 'run-b', programme_id: 'prog-1' }, error: null });
    const r1 = await openRun({ programmeId: 'prog-1', runLabel: 'run-a' }, a.client);
    const r2 = await openRun({ programmeId: 'prog-1', runLabel: 'run-b' }, b.client);
    assert.equal(r1.run.id, 'run-a');
    assert.equal(r2.run.id, 'run-b');
    assert.notEqual(r1.run.id, r2.run.id);
  });
});

describe('transitionRun — mutates lifecycle only, never identity', () => {
  test('legal transition updates status/completed_at, guarded on current status', async () => {
    const updated = { id: 'run-1', status: 'COMPLETED', completed_at: '2026-01-02T00:00:00.000Z' };
    const { client, calls } = fakeClient({ data: updated, error: null });

    const result = await transitionRun('run-1', 'RUNNING', 'COMPLETED', { completedAt: '2026-01-02T00:00:00.000Z' }, client);

    assert.deepEqual(result, { success: true, run: updated });
    // the patch touches ONLY status/completed_at — no id/programme_id/run_label/started_at
    const patch = calls.find(c => c[0] === 'update')[1];
    assert.deepEqual(Object.keys(patch).sort(), ['completed_at', 'status']);
    // optimistic guard: update is filtered by both id and the expected current status
    assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'id' && c[2] === 'run-1'));
    assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'status' && c[2] === 'RUNNING'));
  });

  test('a non-terminal transition does not set completed_at', async () => {
    const { client, calls } = fakeClient({ data: { id: 'run-1', status: 'RUNNING' }, error: null });
    await transitionRun('run-1', 'PENDING', 'RUNNING', {}, client);
    const patch = calls.find(c => c[0] === 'update')[1];
    assert.deepEqual(patch, { status: 'RUNNING' });
    assert.equal('completed_at' in patch, false);
  });

  test('an illegal transition is rejected before any DB call', async () => {
    const { client, calls } = fakeClient({ data: null, error: null });
    const result = await transitionRun('run-1', 'COMPLETED', 'RUNNING', {}, client);
    assert.equal(result.success, false);
    assert.match(result.error, /illegal run transition/);
    assert.equal(calls.length, 0);
  });
});

describe('reads', () => {
  test('getProgrammeByKey returns the row', async () => {
    const { client } = fakeClient({ data: { id: 'p1', programme_key: 'national-tls' }, error: null });
    const p = await getProgrammeByKey('national-tls', client);
    assert.equal(p.programme_key, 'national-tls');
  });

  test('listRunsForProgramme returns runs newest-first (order applied)', async () => {
    const rows = [{ id: 'r2' }, { id: 'r1' }];
    const { client, calls } = fakeClient({ data: rows, error: null });
    const runs = await listRunsForProgramme('p1', client);
    assert.deepEqual(runs, rows);
    assert.ok(calls.some(c => c[0] === 'order' && c[1] === 'started_at'));
  });

  test('getRun returns null on error rather than throwing', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'nope' } });
    const r = await getRun('missing', client);
    assert.equal(r, null);
  });
});
