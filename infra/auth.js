const { createClient } = require('@supabase/supabase-js');
const logger = require('./utils/logger');

let supabase;

function getClient() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required');
    supabase = createClient(url, key);
  }
  return supabase;
}

/**
 * Validates a Supabase-issued access token by asking the Supabase Auth
 * server to introspect it (signature, expiry, and audience are all checked
 * server-side) — this is the backend JWT validation gate (Phase 3 Readiness
 * Checklist B1 / Engineering Plan WS1). No local secret/JWKS management is
 * needed: the existing @supabase/supabase-js dependency already does this,
 * so no new dependency is introduced.
 *
 * Returns { id, email, role } on success, or null on any failure — callers
 * (requireAuth) treat null as unauthenticated and never see a thrown error
 * from this layer.
 *
 * role reads app_metadata.role only, never user_metadata (client-mutable,
 * untrusted) — the same rule the frontend already follows
 * (frontend/src/lib/auth/role.ts).
 */
async function getUserFromToken(token, client = getClient()) {
  if (!token) return null;
  try {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) return null;

    const { id, email, app_metadata } = data.user;
    return { id, email, role: app_metadata?.role ?? null };
  } catch (err) {
    logger.error(`getUserFromToken threw: ${err.message}`);
    return null;
  }
}

module.exports = { getUserFromToken };
