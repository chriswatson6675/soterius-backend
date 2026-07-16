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

module.exports = { findDueCandidates, groupByOrganisation, DEFAULT_LEASE_MS, DEFAULT_OVERFETCH_LIMIT };
