'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { getUserFromToken } = require('./auth');

function fakeSupabase(result, { throws } = {}) {
  const calls = [];
  return {
    calls,
    auth: {
      getUser(token) {
        calls.push(token);
        if (throws) throw throws;
        return Promise.resolve(result);
      },
    },
  };
}

test('getUserFromToken — returns null without calling Supabase when no token given', async () => {
  const client = fakeSupabase({ data: { user: { id: 'u1' } }, error: null });

  const result = await getUserFromToken(undefined, client);

  assert.strictEqual(result, null);
  assert.strictEqual(client.calls.length, 0);
});

test('getUserFromToken — returns {id, email, role} from app_metadata on a valid token', async () => {
  const client = fakeSupabase({
    data: { user: { id: 'u1', email: 'jane@smithllp.co.uk', app_metadata: { role: 'customer' } } },
    error: null,
  });

  const result = await getUserFromToken('valid-jwt', client);

  assert.deepStrictEqual(result, { id: 'u1', email: 'jane@smithllp.co.uk', role: 'customer' });
  assert.deepStrictEqual(client.calls, ['valid-jwt']);
});

test('getUserFromToken — role is null when app_metadata.role is absent', async () => {
  const client = fakeSupabase({ data: { user: { id: 'u1', email: 'jane@x.co.uk', app_metadata: {} } }, error: null });

  const result = await getUserFromToken('valid-jwt', client);

  assert.strictEqual(result.role, null);
});

test('getUserFromToken — never reads user_metadata for role, even if present', async () => {
  const client = fakeSupabase({
    data: {
      user: {
        id: 'u1', email: 'jane@x.co.uk',
        app_metadata: {},
        user_metadata: { role: 'operations' }, // client-mutable — must be ignored
      },
    },
    error: null,
  });

  const result = await getUserFromToken('valid-jwt', client);

  assert.strictEqual(result.role, null);
});

test('getUserFromToken — returns null when Supabase reports an error (expired/invalid signature)', async () => {
  const client = fakeSupabase({ data: { user: null }, error: { message: 'invalid JWT' } });

  const result = await getUserFromToken('expired-or-forged', client);

  assert.strictEqual(result, null);
});

test('getUserFromToken — returns null (not a throw) if the client itself throws', async () => {
  const client = fakeSupabase(null, { throws: new Error('network error') });

  const result = await getUserFromToken('some-jwt', client);

  assert.strictEqual(result, null);
});
