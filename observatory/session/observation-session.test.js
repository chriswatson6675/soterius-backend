'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const S = require('./observation-session');

// Sequence-aware fake Supabase builder: chainable methods return the builder;
// terminal calls (single/maybeSingle) and awaiting the builder itself resolve
// the NEXT configured result — so a single injected client can serve a
// read-then-write op (transition) with two different results.
function fakeClient(results) {
  const queue = Array.isArray(results) ? [...results] : [results];
  const calls = [];
  const next = () => (queue.length > 1 ? queue.shift() : queue[0]);
  const builder = {
    from(t) { calls.push(['from', t]); return builder; },
    insert(r) { calls.push(['insert', r]); return builder; },
    update(p) { calls.push(['update', p]); return builder; },
    select(c) { calls.push(['select', c]); return builder; },
    eq(c, v) { calls.push(['eq', c, v]); return builder; },
    order(...a) { calls.push(['order', ...a]); return builder; },
    limit(n) { calls.push(['limit', n]); return builder; },
    single() { calls.push(['single']); return Promise.resolve(next()); },
    maybeSingle() { calls.push(['maybeSingle']); return Promise.resolve(next()); },
    then(res, rej) { return Promise.resolve(next()).then(res, rej); },
  };
  return { client: builder, calls };
}

// ── Pure state machine ────────────────────────────────────────────────────────

test('isValidTransition — legal lifecycle edges', () => {
  assert.ok(S.isValidTransition('queued', 'running'));
  assert.ok(S.isValidTransition('queued', 'cancelled'));
  assert.ok(S.isValidTransition('running', 'completed'));
  assert.ok(S.isValidTransition('running', 'failed'));
  assert.ok(S.isValidTransition('running', 'cancelled'));
});

test('isValidTransition — illegal edges rejected', () => {
  assert.ok(!S.isValidTransition('queued', 'completed'));  // must run first
  assert.ok(!S.isValidTransition('completed', 'running')); // terminal
  assert.ok(!S.isValidTransition('failed', 'queued'));     // terminal
  assert.ok(!S.isValidTransition('cancelled', 'running')); // terminal
});

test('isTerminal', () => {
  assert.ok(S.isTerminal('completed') && S.isTerminal('failed') && S.isTerminal('cancelled'));
  assert.ok(!S.isTerminal('queued') && !S.isTerminal('running'));
});

test('three initial triggers are supported and the set is extensible', () => {
  assert.deepStrictEqual(S.TRIGGERS, ['batch', 'on-demand', 'scheduled']);
});

// ── createSession ─────────────────────────────────────────────────────────────

test('createSession — defaults to queued, records a creation event, no started_at', async () => {
  const inserted = { id: 's1', trigger: 'on-demand', status: 'queued', started_at: null };
  const { client, calls } = fakeClient({ data: inserted, error: null });

  const r = await S.createSession({ trigger: 'on-demand', scope: { domains: ['x.com'] } }, client);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.session.status, 'queued');
  assert.deepStrictEqual(calls[0], ['from', 'observation_sessions']);
  const row = calls[1][1][0];
  assert.strictEqual(row.status, 'queued');
  assert.strictEqual(row.started_at, null);
  assert.strictEqual(row.events[0].to, 'queued');
  assert.strictEqual(row.events[0].note, 'created');
});

test('createSession — running start sets started_at', async () => {
  const { client, calls } = fakeClient({ data: { id: 's2' }, error: null });
  await S.createSession({ trigger: 'batch', status: 'running' }, client);
  const row = calls[1][1][0];
  assert.strictEqual(row.status, 'running');
  assert.ok(row.started_at, 'started_at set on running start');
});

test('createSession — unknown trigger rejected', async () => {
  const { client } = fakeClient({ data: null, error: null });
  const r = await S.createSession({ trigger: 'webhook' }, client);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown trigger/);
});

test('createSession — non-initial status rejected', async () => {
  const { client } = fakeClient({ data: null, error: null });
  const r = await S.createSession({ trigger: 'batch', status: 'completed' }, client);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /invalid initial status/);
});

// ── transition ────────────────────────────────────────────────────────────────

test('transition — queued -> running sets started_at and appends event', async () => {
  const current = { id: 's1', status: 'queued', events: [{ from: null, to: 'queued', at: 't0' }], metadata: {}, started_at: null };
  const updated = { id: 's1', status: 'running' };
  const { client, calls } = fakeClient([{ data: current, error: null }, { data: updated, error: null }]);

  const r = await S.transition('s1', 'running', { note: 'work started' }, client);

  assert.strictEqual(r.ok, true);
  const patch = calls.find((c) => c[0] === 'update')[1];
  assert.strictEqual(patch.status, 'running');
  assert.ok(patch.started_at, 'started_at set');
  assert.strictEqual(patch.events.length, 2);
  assert.deepStrictEqual({ from: patch.events[1].from, to: patch.events[1].to, note: patch.events[1].note }, { from: 'queued', to: 'running', note: 'work started' });
});

test('transition — running -> completed sets ended_at', async () => {
  const current = { id: 's1', status: 'running', events: [], metadata: {}, started_at: 't1' };
  const { client, calls } = fakeClient([{ data: current, error: null }, { data: { id: 's1', status: 'completed' }, error: null }]);

  const r = await S.transition('s1', 'completed', { metadata: { signalsObserved: 6 } }, client);

  assert.strictEqual(r.ok, true);
  const patch = calls.find((c) => c[0] === 'update')[1];
  assert.ok(patch.ended_at, 'ended_at set on terminal');
  assert.strictEqual(patch.metadata.signalsObserved, 6);
});

test('transition — illegal edge rejected without writing', async () => {
  const current = { id: 's1', status: 'queued', events: [], metadata: {} };
  const { client, calls } = fakeClient([{ data: current, error: null }]);

  const r = await S.transition('s1', 'completed', {}, client);

  assert.strictEqual(r.ok, false);
  assert.match(r.error, /illegal transition queued -> completed/);
  assert.ok(!calls.some((c) => c[0] === 'update'), 'no update issued on illegal transition');
});

test('transition — can attach the run in the same step', async () => {
  const current = { id: 's1', status: 'queued', events: [], metadata: {}, started_at: null };
  const { client, calls } = fakeClient([{ data: current, error: null }, { data: { id: 's1' }, error: null }]);

  await S.transition('s1', 'running', { runLabel: 'on-demand-public-scan-abc', runId: 'r-1' }, client);

  const patch = calls.find((c) => c[0] === 'update')[1];
  assert.strictEqual(patch.run_label, 'on-demand-public-scan-abc');
  assert.strictEqual(patch.run_id, 'r-1');
});

// ── monitoring ────────────────────────────────────────────────────────────────

test('statusCounts — tallies by lifecycle state', async () => {
  const rows = [{ status: 'running' }, { status: 'running' }, { status: 'completed' }, { status: 'failed' }];
  const { client } = fakeClient({ data: rows, error: null });

  const r = await S.statusCounts(client);

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.counts.running, 2);
  assert.strictEqual(r.counts.completed, 1);
  assert.strictEqual(r.counts.failed, 1);
  assert.strictEqual(r.counts.queued, 0);
});

test('listSessions — passes status/trigger filters and a limit', async () => {
  const { client, calls } = fakeClient({ data: [{ id: 's1' }], error: null });
  const r = await S.listSessions({ status: 'running', trigger: 'on-demand', limit: 10 }, client);
  assert.strictEqual(r.ok, true);
  assert.ok(calls.some((c) => c[0] === 'eq' && c[1] === 'status' && c[2] === 'running'));
  assert.ok(calls.some((c) => c[0] === 'eq' && c[1] === 'trigger' && c[2] === 'on-demand'));
  assert.ok(calls.some((c) => c[0] === 'limit' && c[1] === 10));
});
