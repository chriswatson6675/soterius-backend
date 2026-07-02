'use strict';

// bootstrap-dev.test.js — customer/membership/portfolio steps and full
// orchestration only. Auth-user creation (findOrCreateAuthUser) is shared
// with create-ops-user.js and tested once in supabase-auth.test.js.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  bootstrapDev,
  findOrCreateCustomer,
  findOrCreateMembership,
  findOrCreatePortfolioOrganisation,
  findOrCreatePortfolioItem,
} = require('./bootstrap-dev');

// Generic fake query-builder over one or more tables. Each table has its own
// response queue — the Nth call against a table resolves with responses[N-1].
// Mirrors the fake-client style used throughout infra/database.test.js.
function fakeDb(tableQueues = {}) {
  const calls = [];
  function from(table) {
    const queue = tableQueues[table] || [];
    const builder = {
      select(cols)  { calls.push(['select', table, cols]); return builder; },
      insert(rows)  { calls.push(['insert', table, rows]);  return builder; },
      eq(col, val)  { calls.push(['eq', table, col, val]);  return builder; },
      order(col, o) { calls.push(['order', table, col, o]); return builder; },
      limit(n)      { calls.push(['limit', table, n]);      return builder; },
      maybeSingle() { calls.push(['maybeSingle', table]);   return Promise.resolve(queue.shift() ?? { data: null, error: null }); },
      single()      { calls.push(['single', table]);        return Promise.resolve(queue.shift() ?? { data: null, error: null }); },
    };
    return builder;
  }
  return { calls, client: { from } };
}

function fakeAuthAdmin({ createUser, listUsersPages = [], updateUserById } = {}) {
  const calls = { createUser: [], listUsers: [], updateUserById: [] };
  return {
    calls,
    client: {
      auth: {
        admin: {
          createUser: (args) => { calls.createUser.push(args); return Promise.resolve(createUser); },
          listUsers: (args) => {
            calls.listUsers.push(args);
            return Promise.resolve(listUsersPages[calls.listUsers.length - 1] ?? { data: { users: [] }, error: null });
          },
          updateUserById: (id, args) => {
            calls.updateUserById.push([id, args]);
            return Promise.resolve(updateUserById);
          },
        },
      },
    },
  };
}

function mergeClients(...clients) {
  return Object.assign({}, ...clients);
}

// ── findOrCreateCustomer ──────────────────────────────────────────────────────

test('findOrCreateCustomer — reuses an existing customer by name', async () => {
  const existing = { id: 'c1', name: 'Dev Test Organisation' };
  const { client, calls } = fakeDb({ customers: [{ data: existing, error: null }] });

  const result = await findOrCreateCustomer(client, 'Dev Test Organisation');

  assert.deepStrictEqual(result, { customer: existing, created: false });
  assert.ok(!calls.some((c) => c[0] === 'insert'));
});

test('findOrCreateCustomer — creates one when none exists with that name', async () => {
  const created = { id: 'c1', name: 'Dev Test Organisation' };
  const { client } = fakeDb({ customers: [{ data: null, error: null }, { data: created, error: null }] });

  const result = await findOrCreateCustomer(client, 'Dev Test Organisation');

  assert.deepStrictEqual(result, { customer: created, created: true });
});

// ── findOrCreateMembership ────────────────────────────────────────────────────

test('findOrCreateMembership — reuses an existing membership for this user', async () => {
  const existing = { id: 'm1', customer_id: 'c-other', user_id: 'u1', tenant_role: 'owner' };
  const { client } = fakeDb({ memberships: [{ data: existing, error: null }] });

  const result = await findOrCreateMembership(client, 'c1', 'u1');

  // Authoritative even though it points at a different customer_id — this
  // script never fights the UNIQUE(user_id) constraint.
  assert.deepStrictEqual(result, { membership: existing, created: false });
});

test('findOrCreateMembership — creates an owner membership when none exists', async () => {
  const created = { id: 'm1', customer_id: 'c1', user_id: 'u1', tenant_role: 'owner' };
  const { client, calls } = fakeDb({ memberships: [{ data: null, error: null }, { data: created, error: null }] });

  const result = await findOrCreateMembership(client, 'c1', 'u1');

  assert.deepStrictEqual(result, { membership: created, created: true });
  const insertCall = calls.find((c) => c[0] === 'insert' && c[1] === 'memberships');
  assert.deepStrictEqual(insertCall[2], [{ customer_id: 'c1', user_id: 'u1', tenant_role: 'owner' }]);
});

// ── findOrCreatePortfolioOrganisation ─────────────────────────────────────────

test('findOrCreatePortfolioOrganisation — reuses an existing prospect when one exists', async () => {
  const existing = { id: 'o1', firm_name: 'Ashcombe Partners', website: 'ashcombe.co.uk' };
  const { client } = fakeDb({ prospects: [{ data: existing, error: null }] });

  const result = await findOrCreatePortfolioOrganisation(client, { firm_name: 'fallback', website: 'fallback.example' });

  assert.deepStrictEqual(result, { organisation: existing, created: false });
});

test('findOrCreatePortfolioOrganisation — creates the fallback prospect when the table is empty', async () => {
  const fallback = { firm_name: 'Dev Test Organisation', website: 'devtestorg.example.com', sector: 'other', source: 'manual' };
  const created = { id: 'o1', ...fallback };
  const { client, calls } = fakeDb({ prospects: [{ data: null, error: null }, { data: created, error: null }] });

  const result = await findOrCreatePortfolioOrganisation(client, fallback);

  assert.deepStrictEqual(result, { organisation: created, created: true });
  const insertCall = calls.find((c) => c[0] === 'insert' && c[1] === 'prospects');
  assert.deepStrictEqual(insertCall[2], [fallback]);
});

// ── findOrCreatePortfolioItem ─────────────────────────────────────────────────

test('findOrCreatePortfolioItem — leaves an existing portfolio item alone (never swaps organisations)', async () => {
  const existing = { id: 'p1', customer_id: 'c1', organisation_id: 'o-different' };
  const { client, calls } = fakeDb({ organisation_portfolio_items: [{ data: existing, error: null }] });

  const result = await findOrCreatePortfolioItem(client, 'c1', 'o1', 'u1');

  assert.deepStrictEqual(result, { item: existing, created: false });
  assert.ok(!calls.some((c) => c[0] === 'insert'));
});

test('findOrCreatePortfolioItem — creates a home portfolio item when none exists', async () => {
  const created = { id: 'p1', customer_id: 'c1', organisation_id: 'o1', is_home: true };
  const { client, calls } = fakeDb({
    organisation_portfolio_items: [{ data: null, error: null }, { data: created, error: null }],
  });

  const result = await findOrCreatePortfolioItem(client, 'c1', 'o1', 'u1');

  assert.deepStrictEqual(result, { item: created, created: true });
  const insertCall = calls.find((c) => c[0] === 'insert');
  assert.deepStrictEqual(insertCall[2], [{ customer_id: 'c1', organisation_id: 'o1', added_by_user_id: 'u1', is_home: true }]);
});

// ── bootstrapDev (full orchestration) ─────────────────────────────────────────

test('bootstrapDev — a fresh environment creates every row exactly once, with role=customer', async () => {
  const user = { id: 'u1', email: 'dev@soterius.local', app_metadata: { role: 'customer' } };
  const customer = { id: 'c1', name: 'Dev Test Organisation' };
  const membership = { id: 'm1', customer_id: 'c1', user_id: 'u1', tenant_role: 'owner' };
  const organisation = { id: 'o1', firm_name: 'Dev Test Organisation', website: 'devtestorg.example.com' };
  const portfolioItem = { id: 'p1', customer_id: 'c1', organisation_id: 'o1', is_home: true };

  const { client: authClient, calls: authCalls } = fakeAuthAdmin({ createUser: { data: { user }, error: null } });
  const { client: dbClient } = fakeDb({
    customers: [{ data: null, error: null }, { data: customer, error: null }],
    memberships: [{ data: null, error: null }, { data: membership, error: null }],
    prospects: [{ data: null, error: null }, { data: organisation, error: null }],
    organisation_portfolio_items: [{ data: null, error: null }, { data: portfolioItem, error: null }],
  });

  const result = await bootstrapDev(mergeClients(authClient, dbClient));

  assert.strictEqual(result.userCreated, true);
  assert.strictEqual(result.customerCreated, true);
  assert.strictEqual(result.membershipCreated, true);
  assert.strictEqual(result.organisationCreated, true);
  assert.strictEqual(result.portfolioItemCreated, true);
  assert.strictEqual(result.email, 'dev@soterius.local');
  assert.strictEqual(result.customer.id, 'c1');
  assert.strictEqual(result.portfolioItem.organisation_id, 'o1');
  assert.deepStrictEqual(authCalls.createUser[0].app_metadata, { role: 'customer' });
});

test('bootstrapDev — a fully-bootstrapped environment creates nothing on a second run', async () => {
  const user = { id: 'u1', email: 'dev@soterius.local', app_metadata: { role: 'customer' } };
  const customer = { id: 'c1', name: 'Dev Test Organisation' };
  const membership = { id: 'm1', customer_id: 'c1', user_id: 'u1', tenant_role: 'owner' };
  const organisation = { id: 'o1', firm_name: 'Dev Test Organisation', website: 'devtestorg.example.com' };
  const portfolioItem = { id: 'p1', customer_id: 'c1', organisation_id: 'o1', is_home: true };

  const { client: authClient } = fakeAuthAdmin({
    createUser: { data: null, error: { message: 'User already registered' } },
    listUsersPages: [{ data: { users: [user] }, error: null }],
    updateUserById: { data: { user }, error: null },
  });
  const { client: dbClient, calls } = fakeDb({
    customers: [{ data: customer, error: null }],
    memberships: [{ data: membership, error: null }],
    prospects: [{ data: organisation, error: null }],
    organisation_portfolio_items: [{ data: portfolioItem, error: null }],
  });

  const result = await bootstrapDev(mergeClients(authClient, dbClient));

  assert.strictEqual(result.userCreated, false);
  assert.strictEqual(result.customerCreated, false);
  assert.strictEqual(result.membershipCreated, false);
  assert.strictEqual(result.organisationCreated, false);
  assert.strictEqual(result.portfolioItemCreated, false);
  assert.ok(!calls.some((c) => c[0] === 'insert'), 'a fully-bootstrapped rerun must not insert anything');
});
