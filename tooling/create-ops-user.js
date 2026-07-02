'use strict';

// ── Permanent operations user (real environment) ─────────────────────────────
// Creates (or re-affirms the role of) exactly one Supabase Auth user with
// app_metadata.role = 'operations', for logging into the deployed Soterius
// Operations Console. Unlike bootstrap-dev.js, this has no throwaway default
// credentials — OPS_USER_EMAIL and OPS_USER_PASSWORD must be set explicitly,
// since this is meant to be a real, permanent account against the real
// Supabase project, not local-dev-only.
//
// operations is platform-wide by design (ADR-SYS-007 §3.4) — never
// tenant-scoped — so unlike bootstrap-dev.js there is no customers/
// memberships/portfolio step here at all; a valid Auth user with the right
// role is the entire requirement.
//
// Idempotent: safe to re-run — finds the existing user and re-affirms the
// role rather than erroring or duplicating. Run with:
//   OPS_USER_EMAIL=you@soterius.com OPS_USER_PASSWORD=... npm run create:ops-user
// (from backend/)

const { getClient, loadEnv, findOrCreateAuthUser } = require('./supabase-auth');

function resolveConfig() {
  const email = process.env.OPS_USER_EMAIL;
  const password = process.env.OPS_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'OPS_USER_EMAIL and OPS_USER_PASSWORD must both be set — this creates a real, ' +
      'permanent account, so (unlike bootstrap-dev.js) there is no default password.'
    );
  }
  return { email, password };
}

async function createOpsUser(client, config) {
  const { user, created } = await findOrCreateAuthUser(client, { ...config, role: 'operations' });
  return { email: config.email, user, created };
}

module.exports = { createOpsUser, resolveConfig };

if (require.main === module) {
  loadEnv();
  const config = resolveConfig();
  const client = getClient();
  createOpsUser(client, config)
    .then((result) => {
      console.log('\n✔ Operations user ready\n');
      console.log(`  Login email: ${result.email}`);
      console.log(`  Role:        operations (${result.created ? 'created' : 'already existed — role re-affirmed'})`);
      console.log('\nLog in at /login on the deployed frontend with this email and the OPS_USER_PASSWORD you set.\n');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n✖ create-ops-user failed:', err.message);
      process.exit(1);
    });
}
