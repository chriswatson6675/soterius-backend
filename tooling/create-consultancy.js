'use strict';

// ── Compliance Advisor consultancy provisioning (real environment) ──────────
// Creates a real, permanent consultancy account: a Supabase Auth user
// (role: 'customer' — a compliance consultancy IS a normal customer tenant,
// per ENG-047 §2; there is no separate "advisor" role in the auth model), a
// customers row, and a memberships row — reusing bootstrap-dev.js's own
// findOrCreateCustomer/findOrCreateMembership functions directly rather than
// re-implementing the same customers/memberships creation logic a second
// time (ENG-048's own "extend rather than duplicate" instruction).
//
// Unlike bootstrap-dev.js, this is operator-triggered against the real
// project, so — mirroring create-ops-user.js's own precedent — there is no
// default email/password and no auto-seeded portfolio item: a consultancy
// starts with an empty client list and adds firms themselves via the
// existing search-and-add workflow (organisation-search-bar.tsx +
// use-portfolio.ts), already live in production.
//
// Idempotent: every step finds-or-creates, safe to re-run. Run with:
//   CONSULTANCY_EMAIL=... CONSULTANCY_PASSWORD=... CONSULTANCY_NAME="..." \
//     node tooling/create-consultancy.js   (from backend/)

const { getClient, loadEnv, findOrCreateAuthUser } = require('./supabase-auth');
const { findOrCreateCustomer, findOrCreateMembership } = require('./bootstrap-dev');

function resolveConfig(env = process.env) {
  const email = env.CONSULTANCY_EMAIL;
  const password = env.CONSULTANCY_PASSWORD;
  const customerName = env.CONSULTANCY_NAME;
  const missing = ['CONSULTANCY_EMAIL', 'CONSULTANCY_PASSWORD', 'CONSULTANCY_NAME'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `${missing.join(', ')} must be set — this creates a real, permanent consultancy account ` +
      '(unlike bootstrap-dev.js, there is no default email/password/name).',
    );
  }
  return { email, password, customerName };
}

async function createConsultancy(client, config) {
  const { user, created: userCreated } = await findOrCreateAuthUser(client, { ...config, role: 'customer' });
  const { customer, created: customerCreated } = await findOrCreateCustomer(client, config.customerName);
  const { membership, created: membershipCreated } = await findOrCreateMembership(client, customer.id, user.id);

  return {
    email: config.email,
    user, userCreated,
    customer, customerCreated,
    membership, membershipCreated,
  };
}

module.exports = { createConsultancy, resolveConfig };

if (require.main === module) {
  loadEnv();
  const config = resolveConfig();
  const client = getClient();
  createConsultancy(client, config)
    .then((result) => {
      console.log('\n✔ Consultancy account ready\n');
      console.log(`  Login email:   ${result.email}`);
      console.log(`  Consultancy:   ${result.customer.name} (${result.customerCreated ? 'created' : 'already existed'})`);
      console.log(`  Membership:    ${result.membershipCreated ? 'created' : 'already existed'} — role: ${result.membership.tenant_role}`);
      console.log('\nLog in at /login with the email/password provided. Add client firms via search on the My Organisation page.\n');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n✖ create-consultancy failed:', err.message);
      process.exit(1);
    });
}
