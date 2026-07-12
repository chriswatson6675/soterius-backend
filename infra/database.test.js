'use strict';

// database.test.js — Phase 4A customer tenancy + portfolio functions only.
// The rest of database.js predates dependency injection and has no coverage
// here; these tests scope strictly to the functions that accept an
// injectable client, so no real Supabase connection is needed.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  createCustomer, getCustomerById, createMembership, getMembershipByUserId,
  addPortfolioItem, getPortfolioItems, getPortfolioItem, removePortfolioItem,
} = require('./database');

// Minimal fake Supabase query-builder chain. Every non-terminal method
// records the call and returns itself; .single()/.maybeSingle()/.order()
// resolve with the configured result (real supabase-js query builders are
// themselves thenable when no .single()/.maybeSingle() is called — .order()
// stands in for that terminal-await point here since it's always last in
// the queries this file exercises). One instance is good for one query.
function fakeClient(result) {
  const calls = [];
  const builder = {
    from(table)   { calls.push(['from', table]);   return builder; },
    insert(rows)  { calls.push(['insert', rows]);   return builder; },
    select(cols)  { calls.push(['select', cols]);   return builder; },
    delete()      { calls.push(['delete']);         return builder; },
    eq(col, val)  { calls.push(['eq', col, val]);   return builder; },
    order(...args) { calls.push(['order', ...args]); return Promise.resolve(result); },
    single()      { calls.push(['single']);         return Promise.resolve(result); },
    maybeSingle() { calls.push(['maybeSingle']);    return Promise.resolve(result); },
  };
  return { client: builder, calls };
}

test('createCustomer — inserts into customers and returns the row', async () => {
  const row = { id: 'c1', name: 'Smith LLP', plan: 'trial' };
  const { client, calls } = fakeClient({ data: row, error: null });

  const result = await createCustomer('Smith LLP', client);

  assert.deepStrictEqual(result, { success: true, customer: row });
  assert.deepStrictEqual(calls[0], ['from', 'customers']);
  assert.deepStrictEqual(calls[1], ['insert', [{ name: 'Smith LLP' }]]);
});

test('createCustomer — surfaces a Supabase error without throwing', async () => {
  const { client } = fakeClient({ data: null, error: { message: 'insert failed' } });

  const result = await createCustomer('Smith LLP', client);

  assert.deepStrictEqual(result, { success: false, error: 'insert failed' });
});

test('getCustomerById — returns the row on success', async () => {
  const row = { id: 'c1', name: 'Smith LLP' };
  const { client, calls } = fakeClient({ data: row, error: null });

  const result = await getCustomerById('c1', client);

  assert.deepStrictEqual(result, row);
  assert.deepStrictEqual(calls[2], ['eq', 'id', 'c1']);
});

test('getCustomerById — returns null on error rather than throwing', async () => {
  const { client } = fakeClient({ data: null, error: { message: 'not found' } });

  const result = await getCustomerById('missing', client);

  assert.strictEqual(result, null);
});

test('createMembership — defaults tenant_role to member', async () => {
  const row = { id: 'm1', customer_id: 'c1', user_id: 'u1', tenant_role: 'member' };
  const { client, calls } = fakeClient({ data: row, error: null });

  const result = await createMembership('c1', 'u1', undefined, client);

  assert.deepStrictEqual(result, { success: true, membership: row });
  assert.deepStrictEqual(calls[1], ['insert', [{ customer_id: 'c1', user_id: 'u1', tenant_role: 'member' }]]);
});

test('createMembership — accepts an explicit owner role', async () => {
  const row = { id: 'm1', customer_id: 'c1', user_id: 'u1', tenant_role: 'owner' };
  const { client } = fakeClient({ data: row, error: null });

  const result = await createMembership('c1', 'u1', 'owner', client);

  assert.strictEqual(result.membership.tenant_role, 'owner');
});

test('getMembershipByUserId — returns null when the user has no membership yet (not an error)', async () => {
  const { client } = fakeClient({ data: null, error: null });

  const result = await getMembershipByUserId('u-unonboarded', client);

  assert.strictEqual(result, null);
});

test('getMembershipByUserId — maps the joined customer row onto the membership', async () => {
  const joined = {
    id: 'm1',
    tenant_role: 'owner',
    customer_id: 'c1',
    customers: { id: 'c1', name: 'Smith LLP', plan: 'trial' },
  };
  const { client, calls } = fakeClient({ data: joined, error: null });

  const result = await getMembershipByUserId('u1', client);

  assert.deepStrictEqual(result, {
    id: 'm1',
    tenantRole: 'owner',
    customer: { id: 'c1', name: 'Smith LLP', plan: 'trial' },
  });
  assert.deepStrictEqual(calls[2], ['eq', 'user_id', 'u1']);
});

test('getMembershipByUserId — returns null on query error rather than throwing', async () => {
  const { client } = fakeClient({ data: null, error: { message: 'boom' } });

  const result = await getMembershipByUserId('u1', client);

  assert.strictEqual(result, null);
});

// ── Portfolio ──────────────────────────────────────────────────────────────

test('addPortfolioItem — inserts when the organisation is not already in the portfolio', async () => {
  // First call (the existence check) resolves via maybeSingle(); the second
  // (the insert) via single(). One fakeClient() resolves every terminal call
  // to the same result, so this test only asserts the insert path directly.
  const inserted = { id: 'p1', customer_id: 'c1', organisation_id: 'o1', added_by_user_id: 'u1', is_home: false };
  const { client, calls } = fakeClient({ data: inserted, error: null });
  // Force the existence check (first maybeSingle) to report "not found" by
  // giving addPortfolioItem a client whose first terminal call differs from
  // its second — swap maybeSingle to resolve null, single to resolve the row.
  client.maybeSingle = () => { calls.push(['maybeSingle']); return Promise.resolve({ data: null, error: null }); };

  const result = await addPortfolioItem('c1', 'o1', 'u1', client);

  assert.deepStrictEqual(result, { success: true, item: inserted, created: true });
  assert.deepStrictEqual(calls[0], ['from', 'organisation_portfolio_items']);
  assert.deepStrictEqual(
    calls.find(c => c[0] === 'insert'),
    ['insert', [{ customer_id: 'c1', organisation_id: 'o1', added_by_user_id: 'u1' }]]
  );
});

test('addPortfolioItem — is idempotent: returns the existing item without inserting', async () => {
  const existing = { id: 'p1', customer_id: 'c1', organisation_id: 'o1', is_home: false };
  const { client, calls } = fakeClient({ data: existing, error: null }); // maybeSingle finds it

  const result = await addPortfolioItem('c1', 'o1', 'u1', client);

  assert.deepStrictEqual(result, { success: true, item: existing, created: false });
  assert.ok(!calls.some(c => c[0] === 'insert'), 'must not attempt an insert when the item already exists');
});

test('addPortfolioItem — surfaces an insert error without throwing', async () => {
  const { client } = fakeClient({ data: null, error: null });
  client.maybeSingle = () => Promise.resolve({ data: null, error: null }); // not found → falls through to insert
  client.single = () => Promise.resolve({ data: null, error: { message: 'insert failed' } });

  const result = await addPortfolioItem('c1', 'o1', 'u1', client);

  assert.deepStrictEqual(result, { success: false, error: 'insert failed' });
});

test('getPortfolioItems — returns canonical ORG-* ids + metadata; organisation summary is null (resolved via canonical layer, ADR-SYS-010)', async () => {
  const rows = [
    { id: 'p1', organisation_id: 'ORG-5C5F9F99DBC8', is_home: true, added_by_user_id: 'u1', added_at: '2026-07-01T00:00:00Z' },
    { id: 'p2', organisation_id: 'ORG-425AB63B3139', is_home: false, added_by_user_id: 'u1', added_at: '2026-06-15T00:00:00Z' },
  ];
  const { client, calls } = fakeClient({ data: rows, error: null });

  const result = await getPortfolioItems('c1', client);

  assert.deepStrictEqual(result, [
    { id: 'p1', organisationId: 'ORG-5C5F9F99DBC8', isHome: true, addedByUserId: 'u1', addedAt: '2026-07-01T00:00:00Z', organisation: null },
    { id: 'p2', organisationId: 'ORG-425AB63B3139', isHome: false, addedByUserId: 'u1', addedAt: '2026-06-15T00:00:00Z', organisation: null },
  ]);
  assert.deepStrictEqual(calls[2], ['eq', 'customer_id', 'c1']);
});

test('getPortfolioItems — returns [] on error rather than throwing', async () => {
  const { client } = fakeClient({ data: null, error: { message: 'boom' } });

  const result = await getPortfolioItems('c1', client);

  assert.deepStrictEqual(result, []);
});

test('getPortfolioItem — returns null when the organisation is not in the portfolio (not an error)', async () => {
  const { client, calls } = fakeClient({ data: null, error: null });

  const result = await getPortfolioItem('c1', 'o-not-tracked', client);

  assert.strictEqual(result, null);
  assert.deepStrictEqual(calls[3], ['eq', 'organisation_id', 'o-not-tracked']);
});

test('getPortfolioItem — returns the row when present', async () => {
  const row = { id: 'p1', organisation_id: 'o1', is_home: true };
  const { client } = fakeClient({ data: row, error: null });

  const result = await getPortfolioItem('c1', 'o1', client);

  assert.deepStrictEqual(result, row);
});

test('removePortfolioItem — succeeds when a row was deleted', async () => {
  const { client, calls } = fakeClient({ data: { id: 'p1' }, error: null });

  const result = await removePortfolioItem('c1', 'o1', client);

  assert.deepStrictEqual(result, { success: true });
  assert.deepStrictEqual(calls[0], ['from', 'organisation_portfolio_items']);
  assert.ok(calls.some(c => c[0] === 'delete'));
});

test('removePortfolioItem — reports not found when nothing matched (not an error)', async () => {
  const { client } = fakeClient({ data: null, error: null });

  const result = await removePortfolioItem('c1', 'o-not-tracked', client);

  assert.deepStrictEqual(result, { success: false, error: 'Portfolio item not found' });
});

test('removePortfolioItem — surfaces a delete error without throwing', async () => {
  const { client } = fakeClient({ data: null, error: { message: 'boom' } });

  const result = await removePortfolioItem('c1', 'o1', client);

  assert.deepStrictEqual(result, { success: false, error: 'boom' });
});
