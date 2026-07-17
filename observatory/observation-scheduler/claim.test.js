'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { claimDueObservationStates } = require('./claim');
const { insert } = require('../observation-state/store');
const { createObservationState } = require('../observation-state/observation-state');

// Same fake client shape as observation-state/store.test.js — duplicated
// locally (small, self-contained) rather than shared across module
// boundaries for a test-only helper.
function fakeClient() {
  const rows = [];
  let nextId = 1;
  return {
    _rows: rows,
    from(table) {
      if (table !== 'observation_states') throw new Error(`unexpected table ${table}`);
      return {
        insert(row) {
          return { select: () => ({ single: () => { const stored = { id: String(nextId++), created_at: 't', updated_at: 't', ...row }; rows.push(stored); return Promise.resolve({ data: stored, error: null }); } }) };
        },
        select() {
          let filtered = rows;
          const builder = {
            eq(col, val) { filtered = filtered.filter((r) => r[col] === val); return builder; },
            in(col, vals) { filtered = filtered.filter((r) => vals.includes(r[col])); return builder; },
            maybeSingle() { return Promise.resolve({ data: filtered[0] || null, error: null }); },
            then(onFulfilled) { return Promise.resolve({ data: filtered, error: null }).then(onFulfilled); },
          };
          return builder;
        },
        update(patch) {
          let filtered = rows;
          const builder = {
            eq(col, val) { filtered = filtered.filter((r) => r[col] === val); return builder; },
            neq(col, val) { filtered = filtered.filter((r) => r[col] !== val); return builder; },
            or(expr) {
              const clauses = expr.split(',').map((c) => { const [col, op, val] = c.split('.'); return { col, op, val }; });
              filtered = filtered.filter((r) => clauses.some(({ col, op, val }) => (op === 'neq' ? r[col] !== val : op === 'lt' ? r[col] < val : false)));
              return builder;
            },
            select() { return { maybeSingle() { if (!filtered.length) return Promise.resolve({ data: null, error: null }); Object.assign(filtered[0], patch); return Promise.resolve({ data: filtered[0], error: null }); } }; },
          };
          return builder;
        },
      };
    },
  };
}

async function seed(client, organisationId, types) {
  for (const t of types) {
    // eslint-disable-next-line no-await-in-loop
    await insert(createObservationState({ organisationId, observationType: t, collectionGroup: 'dns_batch' }), { client });
  }
}

describe('claimDueObservationStates — due-type-scoped claiming (cadence-safety fix)', () => {
  test('claims only the requested (due) types, not every existing row for the organisation', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf', 'dkim', 'dmarc', 'dnssec', 'caa']);

    const result = await claimDueObservationStates('ORG-1', ['spf', 'dkim'], { client, now: () => '2026-07-17T00:00:00.000Z' });

    assert.equal(result.claimed, true);
    assert.deepStrictEqual(result.claimedTypes.sort(), ['dkim', 'spf']);
    const dnssecRow = client._rows.find((r) => r.observation_type === 'dnssec');
    const caaRow = client._rows.find((r) => r.observation_type === 'caa');
    assert.notEqual(dnssecRow.status, 'running', 'a not-requested type must never be claimed');
    assert.notEqual(caaRow.status, 'running', 'a not-requested type must never be claimed');
  });

  test('only DNSSEC requested — only DNSSEC is claimed', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf', 'dkim', 'dmarc', 'dnssec', 'caa']);
    const result = await claimDueObservationStates('ORG-1', ['dnssec'], { client, now: () => '2026-07-17T00:00:00.000Z' });
    assert.deepStrictEqual(result.claimedTypes, ['dnssec']);
    assert.ok(client._rows.filter((r) => r.observation_type !== 'dnssec').every((r) => r.status !== 'running'));
  });

  test('only CAA requested — only CAA is claimed', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf', 'dkim', 'dmarc', 'dnssec', 'caa']);
    const result = await claimDueObservationStates('ORG-1', ['caa'], { client, now: () => '2026-07-17T00:00:00.000Z' });
    assert.deepStrictEqual(result.claimedTypes, ['caa']);
  });

  test('all five requested — all five are claimed', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf', 'dkim', 'dmarc', 'dnssec', 'caa']);
    const result = await claimDueObservationStates('ORG-1', ['spf', 'dkim', 'dmarc', 'dnssec', 'caa'], { client, now: () => '2026-07-17T00:00:00.000Z' });
    assert.deepStrictEqual(result.claimedTypes.sort(), ['caa', 'dkim', 'dmarc', 'dnssec', 'spf']);
  });

  test('throws on an empty observationTypes array rather than silently claiming nothing', async () => {
    const client = fakeClient();
    await assert.rejects(() => claimDueObservationStates('ORG-1', [], { client }), /non-empty array/);
  });

  test('two overlapping claimers requesting the SAME type — only one succeeds', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf']);
    const first = await claimDueObservationStates('ORG-1', ['spf'], { client, now: () => '2026-07-17T00:00:00.000Z' });
    const second = await claimDueObservationStates('ORG-1', ['spf'], { client, now: () => '2026-07-17T00:01:00.000Z' });
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.deepStrictEqual(second.skippedTypes.map((s) => s.observationType), ['spf']);
  });

  test('two workers requesting DIFFERENT types for the SAME organisation both succeed independently', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf', 'dkim']);
    const workerA = await claimDueObservationStates('ORG-1', ['spf'], { client, now: () => '2026-07-17T00:00:00.000Z' });
    const workerB = await claimDueObservationStates('ORG-1', ['dkim'], { client, now: () => '2026-07-17T00:00:01.000Z' });
    assert.equal(workerA.claimed, true);
    assert.equal(workerB.claimed, true);
    assert.deepStrictEqual(workerA.claimedTypes, ['spf']);
    assert.deepStrictEqual(workerB.claimedTypes, ['dkim']);
  });

  test('a partial claim (one type already taken) still returns the successfully-claimed subset, not an all-or-nothing failure', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf', 'dkim']);
    await claimDueObservationStates('ORG-1', ['spf'], { client, now: () => '2026-07-17T00:00:00.000Z' }); // pre-claim spf
    const result = await claimDueObservationStates('ORG-1', ['spf', 'dkim'], { client, now: () => '2026-07-17T00:01:00.000Z' });
    assert.equal(result.claimed, true, 'dkim was still claimable, so this is a partial success, not a total failure');
    assert.deepStrictEqual(result.claimedTypes, ['dkim']);
    assert.deepStrictEqual(result.skippedTypes.map((s) => s.observationType), ['spf']);
  });

  test('a stale claim (crashed worker, past the lease) can be reclaimed', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf']);
    await claimDueObservationStates('ORG-1', ['spf'], { client, now: () => '2026-07-17T00:00:00.000Z', leaseMs: 900000 });
    const result = await claimDueObservationStates('ORG-1', ['spf'], { client, now: () => '2026-07-17T00:30:00.000Z', leaseMs: 900000 });
    assert.equal(result.claimed, true);
  });
});
