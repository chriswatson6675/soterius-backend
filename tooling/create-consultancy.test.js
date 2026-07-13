'use strict';

// create-consultancy.test.js — Compliance Advisor MVP (ENG-047/ENG-048).
// findOrCreateCustomer/findOrCreateMembership are already tested in
// bootstrap-dev.test.js; this file tests only resolveConfig's validation and
// createConsultancy's own composition (including that it does NOT seed a
// portfolio item, unlike bootstrapDev — a consultancy starts with an empty
// client list).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createConsultancy, resolveConfig } = require('./create-consultancy');

function fakeDb(tableQueues = {}) {
  function from(table) {
    const queue = tableQueues[table] || [];
    const builder = {
      select() { return builder; },
      insert() { return builder; },
      eq() { return builder; },
      maybeSingle() { return Promise.resolve(queue.shift() ?? { data: null, error: null }); },
      single() { return Promise.resolve(queue.shift() ?? { data: null, error: null }); },
    };
    return builder;
  }
  return { from };
}

function fakeAuthAdmin(createUserResult) {
  return {
    auth: { admin: { createUser: () => Promise.resolve(createUserResult) } },
  };
}

function mergedClient(dbQueues, createUserResult) {
  const db = fakeDb(dbQueues);
  const auth = fakeAuthAdmin(createUserResult);
  return { from: db.from, auth: auth.auth };
}

describe('resolveConfig', () => {
  const KEYS = ['CONSULTANCY_EMAIL', 'CONSULTANCY_PASSWORD', 'CONSULTANCY_NAME'];

  test('throws listing every missing var when none are set', () => {
    assert.throws(() => resolveConfig({}), /CONSULTANCY_EMAIL, CONSULTANCY_PASSWORD, CONSULTANCY_NAME must be set/);
  });

  test('throws listing only the missing var when the others are set', () => {
    assert.throws(
      () => resolveConfig({ CONSULTANCY_EMAIL: 'a@b.com', CONSULTANCY_PASSWORD: 'x' }),
      /^Error: CONSULTANCY_NAME must be set/,
    );
  });

  test('returns all three values when set', () => {
    const env = { CONSULTANCY_EMAIL: 'advisor@example.com', CONSULTANCY_PASSWORD: 'StrongPass123!', CONSULTANCY_NAME: 'Acme Compliance' };
    assert.deepStrictEqual(resolveConfig(env), { email: 'advisor@example.com', password: 'StrongPass123!', customerName: 'Acme Compliance' });
  });
});

describe('createConsultancy', () => {
  test('creates a new user (role=customer), customer, and membership — no portfolio item', async () => {
    const user = { id: 'u1', email: 'advisor@example.com', app_metadata: { role: 'customer' } };
    const customer = { id: 'c1', name: 'Acme Compliance' };
    const membership = { id: 'm1', customer_id: 'c1', user_id: 'u1', tenant_role: 'owner' };
    const client = mergedClient(
      {
        customers: [{ data: null, error: null }, { data: customer, error: null }],
        memberships: [{ data: null, error: null }, { data: membership, error: null }],
      },
      { data: { user }, error: null },
    );

    const result = await createConsultancy(client, { email: 'advisor@example.com', password: 'x', customerName: 'Acme Compliance' });

    assert.strictEqual(result.userCreated, true);
    assert.strictEqual(result.customerCreated, true);
    assert.strictEqual(result.membershipCreated, true);
    assert.strictEqual(result.customer.name, 'Acme Compliance');
    assert.strictEqual(result.membership.tenant_role, 'owner');
    // No organisationId/portfolioItem field at all — confirms this composition
    // never calls findOrCreatePortfolioItem, unlike bootstrapDev.
    assert.strictEqual('portfolioItem' in result, false);
    assert.strictEqual('organisationId' in result, false);
  });

  test('is idempotent: re-running against an already-provisioned consultancy creates nothing new', async () => {
    const user = { id: 'u1', email: 'advisor@example.com', app_metadata: { role: 'customer' } };
    const customer = { id: 'c1', name: 'Acme Compliance' };
    const membership = { id: 'm1', customer_id: 'c1', user_id: 'u1', tenant_role: 'owner' };
    const client = mergedClient(
      {
        customers: [{ data: customer, error: null }],
        memberships: [{ data: membership, error: null }],
      },
      { data: null, error: { message: 'User already registered' } },
    );
    // findOrCreateAuthUser falls back to listUsers on a "already registered"
    // createUser error — supply that too.
    client.auth.admin.listUsers = () => Promise.resolve({ data: { users: [user] }, error: null });
    client.auth.admin.updateUserById = () => Promise.resolve({ data: { user }, error: null });

    const result = await createConsultancy(client, { email: 'advisor@example.com', password: 'x', customerName: 'Acme Compliance' });

    assert.strictEqual(result.userCreated, false);
    assert.strictEqual(result.customerCreated, false);
    assert.strictEqual(result.membershipCreated, false);
  });
});
