'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createOpsUser, resolveConfig } = require('./create-ops-user');

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

// ── resolveConfig ─────────────────────────────────────────────────────────────

test('resolveConfig — throws when OPS_USER_EMAIL is missing (no throwaway default for a real account)', () => {
  const prevEmail = process.env.OPS_USER_EMAIL;
  const prevPassword = process.env.OPS_USER_PASSWORD;
  delete process.env.OPS_USER_EMAIL;
  process.env.OPS_USER_PASSWORD = 'x';
  try {
    assert.throws(() => resolveConfig(), /OPS_USER_EMAIL and OPS_USER_PASSWORD must both be set/);
  } finally {
    if (prevEmail === undefined) delete process.env.OPS_USER_EMAIL; else process.env.OPS_USER_EMAIL = prevEmail;
    if (prevPassword === undefined) delete process.env.OPS_USER_PASSWORD; else process.env.OPS_USER_PASSWORD = prevPassword;
  }
});

test('resolveConfig — throws when OPS_USER_PASSWORD is missing', () => {
  const prevEmail = process.env.OPS_USER_EMAIL;
  const prevPassword = process.env.OPS_USER_PASSWORD;
  process.env.OPS_USER_EMAIL = 'ops@soterius.com';
  delete process.env.OPS_USER_PASSWORD;
  try {
    assert.throws(() => resolveConfig(), /OPS_USER_EMAIL and OPS_USER_PASSWORD must both be set/);
  } finally {
    if (prevEmail === undefined) delete process.env.OPS_USER_EMAIL; else process.env.OPS_USER_EMAIL = prevEmail;
    if (prevPassword === undefined) delete process.env.OPS_USER_PASSWORD; else process.env.OPS_USER_PASSWORD = prevPassword;
  }
});

test('resolveConfig — returns both values when set', () => {
  const prevEmail = process.env.OPS_USER_EMAIL;
  const prevPassword = process.env.OPS_USER_PASSWORD;
  process.env.OPS_USER_EMAIL = 'ops@soterius.com';
  process.env.OPS_USER_PASSWORD = 'StrongPass123!';
  try {
    assert.deepStrictEqual(resolveConfig(), { email: 'ops@soterius.com', password: 'StrongPass123!' });
  } finally {
    if (prevEmail === undefined) delete process.env.OPS_USER_EMAIL; else process.env.OPS_USER_EMAIL = prevEmail;
    if (prevPassword === undefined) delete process.env.OPS_USER_PASSWORD; else process.env.OPS_USER_PASSWORD = prevPassword;
  }
});

// ── createOpsUser ──────────────────────────────────────────────────────────────

test('createOpsUser — creates a new user with role=operations', async () => {
  const user = { id: 'u1', email: 'ops@soterius.com', app_metadata: { role: 'operations' } };
  const { client, calls } = fakeAuthAdmin({ createUser: { data: { user }, error: null } });

  const result = await createOpsUser(client, { email: 'ops@soterius.com', password: 'x' });

  assert.deepStrictEqual(result, { email: 'ops@soterius.com', user, created: true });
  assert.deepStrictEqual(calls.createUser[0].app_metadata, { role: 'operations' });
});

test('createOpsUser — is idempotent: re-affirms role=operations on an existing user without duplicating', async () => {
  const existing = { id: 'u1', email: 'ops@soterius.com', app_metadata: {} };
  const updated = { id: 'u1', email: 'ops@soterius.com', app_metadata: { role: 'operations' } };
  const { client, calls } = fakeAuthAdmin({
    createUser: { data: null, error: { message: 'User already registered' } },
    listUsersPages: [{ data: { users: [existing] }, error: null }],
    updateUserById: { data: { user: updated }, error: null },
  });

  const result = await createOpsUser(client, { email: 'ops@soterius.com', password: 'x' });

  assert.deepStrictEqual(result, { email: 'ops@soterius.com', user: updated, created: false });
  assert.deepStrictEqual(calls.updateUserById[0][1].app_metadata, { role: 'operations' });
});
