'use strict';

// ── Developer bootstrap (local development only) ─────────────────────────────
// Creates everything a developer needs to log into the Soterius frontend and
// exercise the customer-tenancy foundation locally: a Supabase Auth user, a
// customers row, a memberships row, and one organisation in that customer's
// portfolio. This is NOT production onboarding/signup/claims — there is no
// verification, no invite flow, and it uses the Supabase service-role key
// directly (admin-level access), which must never be exposed to a browser.
//
// Idempotent: every step finds-or-creates. Re-running this script after the
// first successful run makes no further writes (see each findOrCreate*
// function). Run with: npm run bootstrap:dev (from backend/).

const { getClient, loadEnv, findOrCreateAuthUser } = require('./supabase-auth');
const resolve = require('../organisation/resolve');

const DEFAULT_CONFIG = {
  email: process.env.DEV_USER_EMAIL || 'dev@soterius.local',
  password: process.env.DEV_USER_PASSWORD || 'DevPassword123!',
  customerName: process.env.DEV_CUSTOMER_NAME || 'Dev Test Organisation',
  // Optional: which canonical Organisation to seed the dev portfolio with.
  // A name / SRA / CH / FRN query resolved through the canonical Organisation
  // Resolution Service. If unset, the first organisation in Repository
  // Authority is used, so a developer sees a real, resolvable organisation.
  // There is NO prospects fallback and no synthetic organisation — the dev
  // portfolio only ever holds a canonical ORG-* id (see resolveDevOrganisationId).
  orgQuery: process.env.DEV_ORG_QUERY || null,
};

// ── Step functions — each is independently find-or-create / idempotent ──────
// findOrCreateAuthUser lives in ./supabase-auth (shared with create-ops-user.js).

async function findOrCreateCustomer(client, name) {
  const { data: existing, error: fetchError } = await client
    .from('customers')
    .select('*')
    .eq('name', name)
    .maybeSingle();
  if (fetchError) throw new Error(`customers lookup failed: ${fetchError.message}`);
  if (existing) return { customer: existing, created: false };

  const { data: created, error: insertError } = await client
    .from('customers')
    .insert([{ name }])
    .select('*')
    .single();
  if (insertError) throw new Error(`customers insert failed: ${insertError.message}`);

  return { customer: created, created: true };
}

/**
 * memberships.user_id is UNIQUE (ADR-SYS-007 §3.2 — one tenant per user
 * today) — a membership found here is authoritative even if it points at a
 * different customer row than the one just resolved; this script never
 * fights that constraint.
 */
async function findOrCreateMembership(client, customerId, userId) {
  const { data: existing, error: fetchError } = await client
    .from('memberships')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (fetchError) throw new Error(`memberships lookup failed: ${fetchError.message}`);
  if (existing) return { membership: existing, created: false };

  const { data: created, error: insertError } = await client
    .from('memberships')
    .insert([{ customer_id: customerId, user_id: userId, tenant_role: 'owner' }])
    .select('*')
    .single();
  if (insertError) throw new Error(`memberships insert failed: ${insertError.message}`);

  return { membership: created, created: true };
}

/**
 * Resolve the canonical ORG-* id to seed the dev portfolio with, through the
 * canonical Organisation Resolution Service — never the legacy prospects table.
 * A dev portfolio row must hold a canonical ORG-* id (migration 038); a
 * prospect UUID here was the F-1 identity conflation this replaces.
 *
 * `resolver` is injectable so this is testable without Repository Authority on
 * disk. Throws (fails the bootstrap) with a clear, actionable message when no
 * canonical organisation can be resolved — the dev environment is genuinely
 * not ready, and a silent/synthetic fallback would just re-introduce F-1.
 */
async function resolveDevOrganisationId({ orgQuery } = {}, resolver = resolve) {
  if (orgQuery) {
    const found = resolver.search(orgQuery);
    if (!found.ok) throw new Error(`Organisation resolution failed: ${found.error}`);
    if (!found.results.length) {
      throw new Error(`No canonical organisation matched DEV_ORG_QUERY="${orgQuery}". Try a different name/SRA/CH/FRN, or unset DEV_ORG_QUERY to use the first organisation in Repository Authority.`);
    }
    return { organisationId: found.results[0].id };
  }

  const first = resolver.firstOrganisationId();
  if (!first.ok) {
    throw new Error(`Cannot seed the dev portfolio — ${first.error}`);
  }
  return { organisationId: first.organisationId };
}

/**
 * At most one portfolio item is ever created per customer by this script —
 * if one already exists (any organisation), it's left alone, never swapped.
 * `organisationId` is a canonical ORG-* id (from resolveDevOrganisationId),
 * never a prospect UUID.
 */
async function findOrCreatePortfolioItem(client, customerId, organisationId, addedByUserId) {
  const { data: existing, error: fetchError } = await client
    .from('organisation_portfolio_items')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle();
  if (fetchError) throw new Error(`organisation_portfolio_items lookup failed: ${fetchError.message}`);
  if (existing) return { item: existing, created: false };

  const { data: created, error: insertError } = await client
    .from('organisation_portfolio_items')
    .insert([{ customer_id: customerId, organisation_id: organisationId, added_by_user_id: addedByUserId, is_home: true }])
    .select('*')
    .single();
  if (insertError) throw new Error(`organisation_portfolio_items insert failed: ${insertError.message}`);

  return { item: created, created: true };
}

async function bootstrapDev(client, configOverrides = {}, resolver = resolve) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };

  const { user, created: userCreated } = await findOrCreateAuthUser(client, { ...config, role: 'customer' });
  const { customer, created: customerCreated } = await findOrCreateCustomer(client, config.customerName);
  const { membership, created: membershipCreated } = await findOrCreateMembership(client, customer.id, user.id);
  const { organisationId } = await resolveDevOrganisationId(config, resolver);
  const { item: portfolioItem, created: portfolioItemCreated } =
    await findOrCreatePortfolioItem(client, customer.id, organisationId, user.id);

  return {
    email: config.email,
    password: config.password,
    user, userCreated,
    customer, customerCreated,
    membership, membershipCreated,
    organisationId,
    portfolioItem, portfolioItemCreated,
  };
}

module.exports = {
  bootstrapDev,
  findOrCreateCustomer,
  findOrCreateMembership,
  resolveDevOrganisationId,
  findOrCreatePortfolioItem,
  DEFAULT_CONFIG,
};

if (require.main === module) {
  loadEnv();
  const client = getClient();
  bootstrapDev(client)
    .then((result) => {
      console.log('\n✔ Dev bootstrap complete\n');
      console.log(`  Login email:    ${result.email}`);
      console.log(`  Login password: ${result.password}`);
      console.log(`  Customer:       ${result.customer.name} (${result.customerCreated ? 'created' : 'already existed'})`);
      console.log(`  Membership:     ${result.membershipCreated ? 'created' : 'already existed'} — role: ${result.membership.tenant_role}`);
      console.log(`  Organisation:   ${result.organisationId} (canonical Repository Authority id)`);
      console.log(`  Portfolio item: ${result.portfolioItemCreated ? 'created' : 'already existed'}`);
      console.log('\nStart the backend (npm run dev, in backend/) and the frontend (npm run dev, in frontend/), then log in at /login with the email/password above.\n');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n✖ Dev bootstrap failed:', err.message);
      process.exit(1);
    });
}
