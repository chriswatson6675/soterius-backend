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
  groupByOrganisation,
  groupDueTypesByOrganisation,
  classifyOrganisationDnsStates,
  DEFAULT_LEASE_MS,
  DEFAULT_OVERFETCH_LIMIT,
};
