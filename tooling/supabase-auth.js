'use strict';

// ── Shared Supabase Auth Admin helpers (tooling scripts only) ────────────────
// Idempotent user creation/role-setting, used by both bootstrap-dev.js
// (role: 'customer') and create-ops-user.js (role: 'operations'). Not part
// of the running application — talks to the Supabase Auth Admin API
// directly via the service-role key, which must never reach a browser.

const path = require('path');
const { createClient } = require('@supabase/supabase-js');

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required');
  return createClient(url, key);
}

/** Loads backend/.env — shared so every tooling script resolves it the same way regardless of cwd. */
function loadEnv() {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
}

/**
 * Finds a Supabase Auth user by email by paging through admin.listUsers().
 * There is no admin.getUserByEmail() in supabase-js v2; this is the
 * documented workaround. Fine for the small user counts these tooling
 * scripts deal with.
 */
async function findAuthUserByEmail(client, email, page = 1) {
  const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
  if (error) throw new Error(`listUsers failed: ${error.message}`);

  const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (match) return match;
  if (data.users.length < 200) return null;
  return findAuthUserByEmail(client, email, page + 1);
}

/**
 * Creates a Supabase Auth user with email_confirm: true (no confirmation
 * email flow exists or is wanted for these tooling-created accounts) and
 * app_metadata.role set at creation time. If the user already exists,
 * re-affirms the role on every run instead of assuming it's already
 * correct — self-healing, not just create-once. Existing app_metadata
 * fields other than role are preserved, never clobbered.
 */
async function findOrCreateAuthUser(client, { email, password, role }) {
  if (role !== 'customer' && role !== 'operations') {
    throw new Error(`findOrCreateAuthUser: role must be 'customer' or 'operations', got ${JSON.stringify(role)}`);
  }

  const { data: created, error: createError } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role },
  });

  if (!createError) return { user: created.user, created: true };

  const existing = await findAuthUserByEmail(client, email);
  if (!existing) {
    throw new Error(`createUser failed and no existing user found for ${email}: ${createError.message}`);
  }

  const mergedAppMetadata = { ...(existing.app_metadata ?? {}), role };
  const { data: updated, error: updateError } = await client.auth.admin.updateUserById(existing.id, {
    app_metadata: mergedAppMetadata,
  });
  if (updateError) throw new Error(`Failed to set role on existing user ${email}: ${updateError.message}`);

  return { user: updated.user, created: false };
}

module.exports = { getClient, loadEnv, findAuthUserByEmail, findOrCreateAuthUser };
