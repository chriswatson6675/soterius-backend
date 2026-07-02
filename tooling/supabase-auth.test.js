'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { findAuthUserByEmail, findOrCreateAuthUser } = require('./supabase-auth');

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

// ── findAuthUserByEmail ──────────────────────────────────────────────────────

test('findAuthUserByEmail — returns the matching user (case-insensitive)', async () => {
  const { client } = fakeAuthAdmin({
    listUsersPages: [{ data: { users: [{ id: 'u1', email: 'Dev@Soterius.local' }] }, error: null }],
  });

  const result = await findAuthUserByEmail(client, 'dev@soterius.local');

  assert.deepStrictEqual(result, { id: 'u1', email: 'Dev@Soterius.local' });
});

test('findAuthUserByEmail — returns null when no user matches and there is only one page', async () => {
  const { client } = fakeAuthAdmin({
    listUsersPages: [{ data: { users: [{ id: 'u2', email: 'someone-else@x.com' }] }, error: null }],
  });

  const result = await findAuthUserByEmail(client, 'dev@soterius.local');

  assert.strictEqual(result, null);
});

test('findAuthUserByEmail — paginates when a page is full and has not yet found a match', async () => {
  const fullPage = { data: { users: Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, email: `x${i}@x.com` })) }, error: null };
  const secondPage = { data: { users: [{ id: 'u-match', email: 'dev@soterius.local' }] }, error: null };
  const { client, calls } = fakeAuthAdmin({ listUsersPages: [fullPage, secondPage] });

  const result = await findAuthUserByEmail(client, 'dev@soterius.local');

  assert.strictEqual(result.id, 'u-match');
  assert.strictEqual(calls.listUsers.length, 2);
});

// ── findOrCreateAuthUser ──────────────────────────────────────────────────────

test('findOrCreateAuthUser — rejects an invalid role rather than silently accepting it', async () => {
  const { client } = fakeAuthAdmin();

  await assert.rejects(
    () => findOrCreateAuthUser(client, { email: 'x@x.com', password: 'x', role: 'superadmin' }),
    /role must be 'customer' or 'operations'/
  );
});

test("findOrCreateAuthUser — creates the user with the given role when it does not exist", async () => {
  const newUser = { id: 'u1', email: 'ops@soterius.local', app_metadata: { role: 'operations' } };
  const { client, calls } = fakeAuthAdmin({ createUser: { data: { user: newUser }, error: null } });

  const result = await findOrCreateAuthUser(client, { email: 'ops@soterius.local', password: 'x', role: 'operations' });

  assert.deepStrictEqual(result, { user: newUser, created: true });
  assert.strictEqual(calls.createUser[0].email_confirm, true);
  assert.deepStrictEqual(calls.createUser[0].app_metadata, { role: 'operations' });
});

test('findOrCreateAuthUser — falls back to lookup + role update when the user already exists', async () => {
  const existing = { id: 'u1', email: 'dev@soterius.local', app_metadata: { some_other_field: true } };
  const updated = { id: 'u1', email: 'dev@soterius.local', app_metadata: { some_other_field: true, role: 'customer' } };
  const { client, calls } = fakeAuthAdmin({
    createUser: { data: null, error: { message: 'User already registered' } },
    listUsersPages: [{ data: { users: [existing] }, error: null }],
    updateUserById: { data: { user: updated }, error: null },
  });

  const result = await findOrCreateAuthUser(client, { email: 'dev@soterius.local', password: 'x', role: 'customer' });

  assert.deepStrictEqual(result, { user: updated, created: false });
  // Existing app_metadata is preserved, not clobbered — only role is set.
  assert.deepStrictEqual(calls.updateUserById[0][1].app_metadata, { some_other_field: true, role: 'customer' });
});

test('findOrCreateAuthUser — re-affirms the role even if the existing user already had a different one', async () => {
  const existing = { id: 'u1', email: 'flip@soterius.local', app_metadata: { role: 'customer' } };
  const updated = { id: 'u1', email: 'flip@soterius.local', app_metadata: { role: 'operations' } };
  const { client, calls } = fakeAuthAdmin({
    createUser: { data: null, error: { message: 'User already registered' } },
    listUsersPages: [{ data: { users: [existing] }, error: null }],
    updateUserById: { data: { user: updated }, error: null },
  });

  const result = await findOrCreateAuthUser(client, { email: 'flip@soterius.local', password: 'x', role: 'operations' });

  assert.strictEqual(result.user.app_metadata.role, 'operations');
  assert.deepStrictEqual(calls.updateUserById[0][1].app_metadata, { role: 'operations' });
});

test('findOrCreateAuthUser — throws when createUser fails and no matching user is found either', async () => {
  const { client } = fakeAuthAdmin({
    createUser: { data: null, error: { message: 'network error' } },
    listUsersPages: [{ data: { users: [] }, error: null }],
  });

  await assert.rejects(
    () => findOrCreateAuthUser(client, { email: 'dev@soterius.local', password: 'x', role: 'customer' }),
    /no existing user found/
  );
});
