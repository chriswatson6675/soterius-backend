'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { drainDueStates } = require('./drain');
const { findDuePage } = require('./due-selection');

// ── In-memory fake Supabase client ───────────────────────────────────────────
// Backs a shared rows[] array and supports exactly the query/update chains that
// findDuePage and store.claim() build. update() is applied synchronously
// (read+write with no intervening await), which faithfully models Postgres's
// per-row serialization of concurrent conditional UPDATEs — so two interleaved
// claims of the same row cannot both succeed.
function parseTerm(t) {
  const i1 = t.indexOf('.');
  const col = t.slice(0, i1);
  const rest = t.slice(i1 + 1);
  const i2 = rest.indexOf('.');
  const op = rest.slice(0, i2);
  const val = rest.slice(i2 + 1);
  if (op === 'is' && val === 'null') return (r) => r[col] === null || r[col] === undefined;
  if (op === 'lte') return (r) => r[col] != null && r[col] <= val;
  if (op === 'lt') return (r) => r[col] != null && r[col] < val;
  if (op === 'neq') return (r) => r[col] !== val;
  throw new Error(`fake client: unsupported or-term ${t}`);
}

function makeClient(rows) {
  return {
    from() {
      const b = {
        _op: 'select', _upd: null, _preds: [], _orders: [], _limit: Infinity,
        select() { return b; },
        update(payload) { b._op = 'update'; b._upd = payload; return b; },
        in(col, vals) { b._preds.push((r) => vals.includes(r[col])); return b; },
        not(col, _op, val) { const set = val.replace(/[()]/g, '').split(','); b._preds.push((r) => !set.includes(r[col])); return b; },
        eq(col, val) { b._preds.push((r) => r[col] === val); return b; },
        neq(col, val) { b._preds.push((r) => r[col] !== val); return b; },
        lt(col, val) { b._preds.push((r) => r[col] != null && r[col] < val); return b; },
        or(expr) { const terms = expr.split(',').map(parseTerm); b._preds.push((r) => terms.some((t) => t(r))); return b; },
        order(col, opts) { b._orders.push({ col, asc: !opts || opts.ascending !== false, nullsFirst: !!(opts && opts.nullsFirst) }); return b; },
        limit(n) { b._limit = n; return Promise.resolve(exec()); },
        maybeSingle() { const res = exec(); return Promise.resolve({ data: res.data.length ? { ...res.data[0] } : null, error: null }); },
        then(resolve, reject) { return Promise.resolve(exec()).then(resolve, reject); },
      };
      const match = (r) => b._preds.every((p) => p(r));
      function sortRows(arr) {
        return arr.slice().sort((x, y) => {
          for (const o of b._orders) {
            const a = x[o.col]; const c = y[o.col];
            if (a === c) continue;
            if (a == null) return o.nullsFirst ? -1 : 1;
            if (c == null) return o.nullsFirst ? 1 : -1;
            const cmp = a < c ? -1 : 1;
            return o.asc ? cmp : -cmp;
          }
          return 0;
        });
      }
      function exec() {
        if (b._op === 'update') {
          const affected = [];
          for (const r of rows) if (match(r)) { Object.assign(r, b._upd); affected.push({ ...r }); }
          return { data: affected, error: null };
        }
        let out = sortRows(rows.filter(match));
        if (b._limit < out.length) out = out.slice(0, b._limit);
        return { data: out.map((r) => ({ ...r })), error: null };
      }
      return b;
    },
  };
}

const NOW = '2026-03-10T12:00:00.000Z';
const FUTURE = '2030-01-01T00:00:00.000Z';
const TYPES = ['spf', 'dkim', 'dmarc'];

function seed({ orgs = 400 } = {}) {
  const rows = [];
  for (let i = 0; i < orgs; i += 1) {
    const org = `ORG-${String(i).padStart(5, '0')}`;
    // distinct past due-times: older (smaller ISO) for lower i
    const due = new Date(Date.parse('2026-03-01T00:00:00.000Z') + i * 60000).toISOString();
    for (const t of TYPES) rows.push({ organisation_id: org, observation_type: t, next_due_at: due, status: 'observed', updated_at: due });
  }
  return rows;
}

// Fake observe: marks each claimed (org,type) observed and pushes next_due into
// the future so it leaves the due set. Records calls to detect duplicates.
function makeObserve(rows, calls) {
  return async (organisationId, deps) => {
    const results = [];
    for (const signal of deps.signalTypes) {
      const key = `${organisationId}:${signal}`;
      calls.set(key, (calls.get(key) || 0) + 1);
      const row = rows.find((r) => r.organisation_id === organisationId && r.observation_type === signal);
      if (row) { row.status = 'observed'; row.next_due_at = FUTURE; row.updated_at = NOW; }
      results.push({ signal, ok: true });
    }
    return { organisationId, ok: true, domain: 'example.com', results };
  };
}

describe('findDuePage — deterministic ordering and bounded page', () => {
  test('returns oldest-due first, tiebroken by (org, type), capped at pageSize', async () => {
    const rows = seed({ orgs: 10 });
    const page = await findDuePage({ now: NOW, pageSize: 7 }, { client: makeClient(rows) });
    assert.equal(page.length, 7);
    for (let i = 1; i < page.length; i += 1) {
      const prev = page[i - 1]; const cur = page[i];
      assert.ok(
        prev.nextDueAt < cur.nextDueAt
        || (prev.nextDueAt === cur.nextDueAt && prev.organisationId <= cur.organisationId),
        'ordered oldest-due then organisation',
      );
    }
  });

  test('excludes suspended and running (non-stale) and future states', async () => {
    const rows = [
      { organisation_id: 'ORG-A', observation_type: 'spf', next_due_at: '2026-01-01T00:00:00.000Z', status: 'observed', updated_at: NOW },
      { organisation_id: 'ORG-B', observation_type: 'spf', next_due_at: '2026-01-01T00:00:00.000Z', status: 'suspended', updated_at: NOW },
      { organisation_id: 'ORG-C', observation_type: 'spf', next_due_at: FUTURE, status: 'observed', updated_at: NOW },
      { organisation_id: 'ORG-D', observation_type: 'spf', next_due_at: '2026-01-01T00:00:00.000Z', status: 'running', updated_at: NOW },
    ];
    const page = await findDuePage({ now: NOW, pageSize: 50 }, { client: makeClient(rows) });
    assert.deepEqual(page.map((p) => p.organisationId), ['ORG-A']);
  });
});

describe('drainDueStates — full-population bounded draining', () => {
  test('drains every due state across multiple pages when the budget is high', async () => {
    const rows = seed({ orgs: 400 }); // 1200 due states
    const calls = new Map();
    const summary = await drainDueStates(
      { now: NOW, pageSize: 250, maxStatesPerRun: 100000, concurrency: 8 },
      { client: makeClient(rows), observeOrganisationDnsSignals: makeObserve(rows, calls) },
    );
    assert.equal(summary.statesCompleted, 1200);
    assert.equal(summary.statesFailed, 0);
    assert.ok(summary.pagesFetched > 1, 'used multiple pages');
    assert.equal(summary.stoppedReason, 'drained');
    assert.equal(rows.filter((r) => r.status === 'observed' && r.next_due_at === FUTURE).length, 1200);
    // no duplicate processing
    assert.ok([...calls.values()].every((n) => n === 1));
  });

  test('work-budget stops early; a second invocation completes the remainder (no starvation)', async () => {
    const rows = seed({ orgs: 400 });
    const calls = new Map();
    const deps = { client: makeClient(rows), observeOrganisationDnsSignals: makeObserve(rows, calls) };
    const first = await drainDueStates({ now: NOW, pageSize: 250, maxStatesPerRun: 300, concurrency: 8 }, deps);
    assert.equal(first.budgetExhausted, true);
    assert.equal(first.stoppedReason, 'work-budget');
    // Soft ceiling: bounded overshoot of at most concurrency × maxTypesPerOrg
    // (in-flight lanes each pass their budget check before it trips).
    assert.ok(first.statesClaimed >= 300 && first.statesClaimed <= 300 + 8 * 3, `claimed within soft budget, got ${first.statesClaimed}`);
    const second = await drainDueStates({ now: NOW, pageSize: 250, maxStatesPerRun: 100000, concurrency: 8 }, deps);
    assert.equal(first.statesCompleted + second.statesCompleted, 1200);
    assert.ok([...calls.values()].every((n) => n === 1), 'each state observed exactly once across both runs');
  });

  test('overlapping invocations never double-process a state (atomic claim exclusivity)', async () => {
    const rows = seed({ orgs: 200 }); // 600 states
    const calls = new Map();
    const client = makeClient(rows);
    const observe = makeObserve(rows, calls);
    const [a, b] = await Promise.all([
      drainDueStates({ now: NOW, pageSize: 120, maxStatesPerRun: 100000, concurrency: 8 }, { client, observeOrganisationDnsSignals: observe }),
      drainDueStates({ now: NOW, pageSize: 120, maxStatesPerRun: 100000, concurrency: 8 }, { client, observeOrganisationDnsSignals: observe }),
    ]);
    assert.equal(a.statesCompleted + b.statesCompleted, 600);
    assert.ok([...calls.values()].every((n) => n === 1), 'no state observed twice');
    assert.equal(new Set(calls.keys()).size, 600);
  });

  test('reclaims a stale (crashed-worker) running claim and completes it', async () => {
    const rows = [
      { organisation_id: 'ORG-STALE', observation_type: 'spf', next_due_at: '2026-01-01T00:00:00.000Z', status: 'running', updated_at: '2026-03-10T11:00:00.000Z' }, // >15min old
      { organisation_id: 'ORG-FRESH', observation_type: 'spf', next_due_at: '2026-01-01T00:00:00.000Z', status: 'running', updated_at: '2026-03-10T11:59:00.000Z' }, // <15min old — not stale
    ];
    const calls = new Map();
    const summary = await drainDueStates(
      { now: NOW, pageSize: 50, maxStatesPerRun: 100000, concurrency: 4 },
      { client: makeClient(rows), observeOrganisationDnsSignals: makeObserve(rows, calls) },
    );
    assert.equal(summary.statesCompleted, 1);
    assert.equal(calls.get('ORG-STALE:spf'), 1);
    assert.equal(calls.has('ORG-FRESH:spf'), false, 'a non-stale running claim is left alone');
  });

  test('no starvation with >5000 due rows all sharing an identical next_due_at (last-sorting org still executes)', async () => {
    // 2000 orgs × 3 = 6000 states, ALL due at the same instant → ordering falls
    // entirely to the (org, type) tiebreak. Prove full drain and that the
    // lexicographically-last organisation is processed.
    const rows = [];
    const due = '2026-02-01T00:00:00.000Z';
    for (let i = 0; i < 2000; i += 1) {
      const org = `ORG-${String(i).padStart(5, '0')}`;
      for (const t of TYPES) rows.push({ organisation_id: org, observation_type: t, next_due_at: due, status: 'observed', updated_at: due });
    }
    const calls = new Map();
    const summary = await drainDueStates(
      { now: NOW, pageSize: 250, maxStatesPerRun: 100000, concurrency: 8 },
      { client: makeClient(rows), observeOrganisationDnsSignals: makeObserve(rows, calls) },
    );
    assert.equal(summary.statesCompleted, 6000);
    assert.ok(summary.pagesFetched >= 24);
    assert.equal(calls.get('ORG-01999:dmarc'), 1, 'the last-sorting org/type executed exactly once');
    assert.equal([...calls.values()].filter((n) => n !== 1).length, 0);
  });

  test('runtime budget triggers a clean graceful stop', async () => {
    const rows = seed({ orgs: 400 });
    let t = 0;
    const summary = await drainDueStates(
      { now: NOW, pageSize: 250, maxStatesPerRun: 100000, concurrency: 8, runtimeBudgetMs: 1000 },
      {
        client: makeClient(rows),
        observeOrganisationDnsSignals: makeObserve(rows, new Map()),
        monotonic: () => { t += 600; return t; }, // advances 600ms per call → exceeds 1000ms quickly
      },
    );
    assert.equal(summary.stoppedReason, 'runtime-budget');
    assert.equal(summary.budgetExhausted, true);
  });
});
