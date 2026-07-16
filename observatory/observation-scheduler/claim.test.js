'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { claimOrganisationDnsStates } = require('./claim');
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

describe('claimOrganisationDnsStates', () => {
  test('an organisation with no existing rows needs no claim (never-yet-observed)', async () => {
    const client = fakeClient();
    const result = await claimOrganisationDnsStates('ORG-1', { client, now: () => '2026-07-16T00:00:00.000Z' });
    assert.deepStrictEqual(result, { claimed: true, claimedTypes: [] });
  });

  test('claims every existing DNS row for the organisation', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf', 'dkim', 'dmarc', 'dnssec', 'caa']);
    const result = await claimOrganisationDnsStates('ORG-1', { client, now: () => '2026-07-16T00:00:00.000Z' });
    assert.equal(result.claimed, true);
    assert.deepStrictEqual(result.claimedTypes.sort(), ['caa', 'dkim', 'dmarc', 'dnssec', 'spf']);
    assert.ok(client._rows.every((r) => r.status === 'running'));
  });

  test('a partially-populated organisation (some signals never observed) claims only what exists', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf', 'dkim']);
    const result = await claimOrganisationDnsStates('ORG-1', { client, now: () => '2026-07-16T00:00:00.000Z' });
    assert.equal(result.claimed, true);
    assert.deepStrictEqual(result.claimedTypes.sort(), ['dkim', 'spf']);
  });

  test('two overlapping claimers for the same organisation — only one succeeds', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf', 'dkim']);
    const first = await claimOrganisationDnsStates('ORG-1', { client, now: () => '2026-07-16T00:00:00.000Z' });
    const second = await claimOrganisationDnsStates('ORG-1', { client, now: () => '2026-07-16T00:01:00.000Z' });
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.match(second.reason, /already running elsewhere/);
  });

  test('a different organisation is entirely unaffected by another\'s claim', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf']);
    await seed(client, 'ORG-2', ['spf']);
    await claimOrganisationDnsStates('ORG-1', { client, now: () => '2026-07-16T00:00:00.000Z' });
    const result = await claimOrganisationDnsStates('ORG-2', { client, now: () => '2026-07-16T00:00:00.000Z' });
    assert.equal(result.claimed, true);
  });

  test('a stale claim (crashed worker, past the lease) can be reclaimed', async () => {
    const client = fakeClient();
    await seed(client, 'ORG-1', ['spf']);
    await claimOrganisationDnsStates('ORG-1', { client, now: () => '2026-07-16T00:00:00.000Z', leaseMs: 900000 });
    const result = await claimOrganisationDnsStates('ORG-1', { client, now: () => '2026-07-16T00:30:00.000Z', leaseMs: 900000 });
    assert.equal(result.claimed, true);
  });
});
