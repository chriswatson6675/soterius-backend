'use strict';

// Due-observation selection — OBS-103 (Observation Scheduler).
//
// Answers "what's due now" over observation_states, scoped to the five
// DNS-based observation types OBS-102 supports. Two separate, simple queries
// merged in JS — a normal due-candidate query and a stale-claim (crashed
// worker) query — rather than one compound OR filter, so each is easy to
// verify correct and easy to test independently.
//
// No due-selection logic lives on the frozen Observation State contract
// itself (observation-state.js) — this module is purely additive, reading
// observation_states, never redefining its shape.

const { DNS_OBSERVATION_TYPES } = require('../observation-state/dns-signal-collection');

function getClient() { return require('../../infra/database').getClient(); }

const DEFAULT_LEASE_MS = 15 * 60 * 1000; // 15 minutes — see claim.js for the claim side of this
const DEFAULT_OVERFETCH_LIMIT = 500;
// Default page size for the full-population draining path (findDuePage). Small
// enough to bound memory and keep each page fast; the scheduler drains multiple
// pages per wake up to its work budget, so this is NOT an effective ceiling on
// work done (that is --max-states-per-run). Replaces the old hard 500 ceiling.
const DEFAULT_PAGE_SIZE = 250;

/**
 * findDueCandidates({ now, leaseMs, overfetchLimit }, deps) →
 *   Array<{ organisationId, observationType, nextDueAt, status, updatedAt }>
 *
 * Two queries, merged:
 *   1. Normal due candidates: not suspended, not currently running, and
 *      next_due_at is null or has passed.
 *   2. Stale claims: status is 'running' but has been so for longer than
 *      leaseMs — a crashed worker's abandoned claim, now reclaimable.
 *
 * Ordered soonest-due-first (nulls first — a never-yet-observed row is
 * always at least as due as any timestamped one).
 */
async function findDueCandidates({ now, leaseMs = DEFAULT_LEASE_MS, overfetchLimit = DEFAULT_OVERFETCH_LIMIT } = {}, deps = {}) {
  const client = deps.client || getClient();
  const nowIso = now || new Date().toISOString();
  const staleThreshold = new Date(Date.parse(nowIso) - leaseMs).toISOString();

  const dueRes = await client
    .from('observation_states')
    .select('organisation_id, observation_type, next_due_at, status, updated_at')
    .in('observation_type', DNS_OBSERVATION_TYPES)
    .not('status', 'in', '(suspended,running)')
    .or(`next_due_at.is.null,next_due_at.lte.${nowIso}`)
    .order('next_due_at', { ascending: true, nullsFirst: true })
    .limit(overfetchLimit);
  if (dueRes.error) throw new Error(`due-candidate query failed: ${dueRes.error.message}`);

  const staleRes = await client
    .from('observation_states')
    .select('organisation_id, observation_type, next_due_at, status, updated_at')
    .in('observation_type', DNS_OBSERVATION_TYPES)
    .eq('status', 'running')
    .lt('updated_at', staleThreshold)
    .limit(overfetchLimit);
  if (staleRes.error) throw new Error(`stale-claim query failed: ${staleRes.error.message}`);

  return [...(dueRes.data || []), ...(staleRes.data || [])].map((r) => ({
    organisationId: r.organisation_id,
    observationType: r.observation_type,
    nextDueAt: r.next_due_at,
    status: r.status,
    updatedAt: r.updated_at,
  }));
}

/**
 * findDuePage({ now, leaseMs, pageSize }, deps) → up to pageSize due candidates,
 * DETERMINISTICALLY ordered oldest-due first with a total tiebreak on
 * (organisation_id, observation_type).
 *
 * This is the bounded-draining primitive for full-population scheduling — it
 * replaces any reliance on a single 500-row overfetch. The scheduler calls it
 * repeatedly within one wake: because a claimed row flips to 'running' and
 * thereby leaves this result set, re-querying naturally advances to the
 * next-oldest page with NO offset arithmetic and NO offset drift, and any work
 * left unclaimed simply stays due for the next wake. Oldest-due-first ordering
 * guarantees no organisation is starved: a state can only be overtaken by a
 * strictly-older-due state, and older states are drained first.
 *
 * The page is topped up with reclaimable stale claims (a crashed worker's
 * abandoned 'running' rows older than the lease) only when there is spare room,
 * so the returned array never exceeds pageSize (bounded memory).
 */
async function findDuePage({ now, leaseMs = DEFAULT_LEASE_MS, pageSize = DEFAULT_PAGE_SIZE } = {}, deps = {}) {
  const client = deps.client || getClient();
  const nowIso = now || new Date().toISOString();
  const staleThreshold = new Date(Date.parse(nowIso) - leaseMs).toISOString();

  const dueRes = await client
    .from('observation_states')
    .select('organisation_id, observation_type, next_due_at, status, updated_at')
    .in('observation_type', DNS_OBSERVATION_TYPES)
    .not('status', 'in', '(suspended,running)')
    .or(`next_due_at.is.null,next_due_at.lte.${nowIso}`)
    .order('next_due_at', { ascending: true, nullsFirst: true })
    .order('organisation_id', { ascending: true })
    .order('observation_type', { ascending: true })
    .limit(pageSize);
  if (dueRes.error) throw new Error(`due-page query failed: ${dueRes.error.message}`);

  const rows = dueRes.data || [];
  let staleRows = [];
  if (rows.length < pageSize) {
    const staleRes = await client
      .from('observation_states')
      .select('organisation_id, observation_type, next_due_at, status, updated_at')
      .in('observation_type', DNS_OBSERVATION_TYPES)
      .eq('status', 'running')
      .lt('updated_at', staleThreshold)
      .order('updated_at', { ascending: true })
      .order('organisation_id', { ascending: true })
      .limit(pageSize - rows.length);
    if (staleRes.error) throw new Error(`stale-page query failed: ${staleRes.error.message}`);
    staleRows = staleRes.data || [];
  }

  return [...rows, ...staleRows].map((r) => ({
    organisationId: r.organisation_id,
    observationType: r.observation_type,
    nextDueAt: r.next_due_at,
    status: r.status,
    updatedAt: r.updated_at,
  }));
}

/**
 * groupByOrganisation(candidates) → organisation ids, deduplicated, in
 * first-seen order (soonest-due-first, since candidates already arrive
 * sorted that way from findDueCandidates).
 *
 * Retained for callers that only need "which organisations have something
 * due" (e.g. the aggregate log line) — groupDueTypesByOrganisation below is
 * the one the scheduler's own selection/claim/collection logic uses, since
 * it preserves exactly WHICH types are due, not just that some are.
 */
function groupByOrganisation(candidates) {
  const seen = new Set();
  const order = [];
  for (const c of candidates) {
    if (!seen.has(c.organisationId)) {
      seen.add(c.organisationId);
      order.push(c.organisationId);
    }
  }
  return order;
}

/**
 * groupDueTypesByOrganisation(candidates) →
 *   Array<{ organisationId, dueTypes: string[] }>, soonest-due-first,
 *   in first-seen organisation order.
 *
 * Cadence-safety fix (2026-07-17): the earlier grouping discarded which
 * specific observation types were due for each organisation, which is
 * exactly why every organisation ended up running all five DNS signals
 * regardless of which one(s) actually triggered its selection — a daily
 * SPF/DKIM/DMARC due-date was resetting weekly DNSSEC/CAA's cadence too.
 * This preserves the due-type list per organisation so the caller can claim
 * and collect only what's genuinely due.
 */
function groupDueTypesByOrganisation(candidates) {
  const order = [];
  const dueTypesByOrg = new Map();
  for (const c of candidates) {
    if (!dueTypesByOrg.has(c.organisationId)) {
      dueTypesByOrg.set(c.organisationId, []);
      order.push(c.organisationId);
    }
    dueTypesByOrg.get(c.organisationId).push(c.observationType);
  }
  return order.map((organisationId) => ({ organisationId, dueTypes: dueTypesByOrg.get(organisationId) }));
}

/**
 * classifyOrganisationDnsStates(organisationId, dueTypes, deps) →
 *   { due: string[], future: string[], suspended: string[] }
 *
 * For ONE already-selected organisation, fetches every existing DNS
 * Observation State row and classifies each against the already-computed
 * due-type list — purely for CLI reporting detail (which types were future/
 * suspended, not just which were due). Never called population-wide; only
 * for organisations already in the scheduler's selected cohort.
 */
async function classifyOrganisationDnsStates(organisationId, dueTypes, deps = {}) {
  const client = deps.client || getClient();
  const store = require('../observation-state/store');
  const existing = await store.getAllByOrganisation(organisationId, DNS_OBSERVATION_TYPES, { client });
  const dueSet = new Set(dueTypes);
  const result = { due: [], future: [], suspended: [] };
  for (const row of existing) {
    if (row.status === 'suspended') result.suspended.push(row.observationType);
    else if (dueSet.has(row.observationType)) result.due.push(row.observationType);
    else result.future.push(row.observationType);
  }
  return result;
}

module.exports = {
  findDueCandidates,
  findDuePage,
  groupByOrganisation,
  groupDueTypesByOrganisation,
  classifyOrganisationDnsStates,
  DEFAULT_LEASE_MS,
  DEFAULT_OVERFETCH_LIMIT,
  DEFAULT_PAGE_SIZE,
};
