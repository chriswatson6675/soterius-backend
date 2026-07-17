'use strict';

// Observation Scheduler — OBS-103.
//
// CORRECTED FOR INDEPENDENT CADENCE (2026-07-17). The original version
// selected an organisation when ANY of its DNS Observation States was due,
// then collected all five signals for it regardless — because SPF/DKIM/
// DMARC are daily and DNSSEC/CAA are weekly, this reset the weekly signals'
// cadence every time a daily signal triggered selection, defeating the
// independent-cadence model Observation State.next_due_at exists to
// represent. Fixed by threading the specific due TYPE list all the way
// through selection -> claim -> collection, using OBS-102's new bounded
// signal-subset support (observeOrganisationDnsSignals deps.signalTypes).
//
// --org SEMANTICS (also corrected): previously bypassed due-eligibility
// entirely — a named organisation ran regardless of whether anything was
// actually due, which is surprising ("why did this scan a signal that isn't
// due yet?"). --org now RESTRICTS selection to the named organisations while
// PRESERVING normal due-state eligibility: a named-but-not-due organisation
// is skipped, and a named organisation with some due and some not-due types
// runs only the due subset. --force-org is the explicit, clearly-warned
// escape hatch for the old bypass behaviour (still useful for supervised
// corrective runs, as used earlier in this program's own history) — never
// intended for a recurring scheduler.
//
// --now SAFETY (also corrected): permitted ONLY in combination with
// --dry-run (Part 5, Option A). A real run always uses the real wall clock
// for every persisted timestamp — this single guard eliminates, by
// construction, the entire risk class of a future-dated claim being
// stranded behind an artificial timestamp the normal 15-minute lease can't
// reach until real time catches up to it.
//
// Never generates a Trust Profile, never calls Companies House/FCA/SRA — it
// only ever calls observeOrganisationDnsSignals, which already excludes all
// of that (OBS-102, unchanged). Not a cron, not a Railway service, not a
// persistent worker.

const {
  findDueCandidates, groupDueTypesByOrganisation, classifyOrganisationDnsStates,
} = require('./due-selection');
const { claimDueObservationStates } = require('./claim');
const { observeOrganisationDnsSignals } = require('../observation-state/observe-organisation');
const { DNS_OBSERVATION_TYPES } = require('../observation-state/dns-signal-collection');

function getClient() { return require('../../infra/database').getClient(); }

function emptySummary() {
  return {
    organisationsSelected: 0, statesSelected: 0, statesClaimed: 0,
    statesCompleted: 0, statesFailed: 0, statesSkippedFuture: 0, statesSkippedSuspendedOrClaimed: 0,
  };
}

/**
 * runScheduler({ orgIds, limit, dryRun, now, forceOrg, productionUnbounded }, deps) →
 *   { ok: false, refused: true, reason }
 *   | { ok: true, dryRun: true, cohort, summary, plan }
 *   | { ok: true, dryRun: false, cohort, summary, results }
 *
 * Bounding/eligibility rules:
 *   - --org (no --force-org): restricts selection to the named organisations
 *     AND their genuinely due types only — a named-but-not-due organisation
 *     is skipped; a partially-due one runs only its due subset.
 *   - --force-org (requires --org): bypasses due-eligibility for the named
 *     organisations, claiming and collecting all five DNS types regardless —
 *     clearly warned, incompatible with --production, never intended for a
 *     recurring scheduler.
 *   - --limit (no --org): deterministically takes the first N genuinely due
 *     organisations (soonest-due-first), each running only its due subset.
 *   - neither --org nor --limit: refused, unless productionUnbounded is set
 *     (every currently due organisation, never the full registry — still
 *     never enabled by this work package).
 *   - --now: permitted only when dryRun is true.
 */
async function runScheduler({
  orgIds = [], limit = null, dryRun = false, now = null, forceOrg = false, productionUnbounded = false,
} = {}, deps = {}) {
  const log = deps.log || (() => {});
  const client = deps.client || getClient();

  if (now && !dryRun) {
    const reason = '--now is only permitted together with --dry-run — a real run always uses the real wall clock, so no future-dated claim can ever be stranded.';
    log(`OBS-103: refused — ${reason}`);
    return { ok: false, refused: true, reason };
  }
  if (forceOrg && orgIds.length === 0) {
    const reason = '--force-org requires at least one explicit --org.';
    log(`OBS-103: refused — ${reason}`);
    return { ok: false, refused: true, reason };
  }
  if (forceOrg && productionUnbounded) {
    const reason = '--force-org cannot be combined with --production (unbounded due-population execution).';
    log(`OBS-103: refused — ${reason}`);
    return { ok: false, refused: true, reason };
  }

  const nowIso = now || new Date().toISOString();

  const findCandidates = deps.findDueCandidates || findDueCandidates;
  const candidates = await findCandidates({ now: nowIso }, { client });
  const dueGroups = groupDueTypesByOrganisation(candidates);
  const dueByOrg = new Map(dueGroups.map((g) => [g.organisationId, g.dueTypes]));
  const dueOrgIdsOrdered = dueGroups.map((g) => g.organisationId);

  log(`OBS-103: ${candidates.length} due (organisation, signal) candidate(s) across ${dueOrgIdsOrdered.length} organisation(s)`);

  let plannedOrgIds;
  if (forceOrg) {
    log('OBS-103: WARNING — --force-org bypasses cadence eligibility for the named organisation(s). This must never be used by a recurring production scheduler.');
    plannedOrgIds = [...new Set(orgIds)];
  } else if (orgIds.length > 0) {
    plannedOrgIds = orgIds.filter((id) => dueByOrg.has(id));
    for (const id of orgIds) {
      if (!dueByOrg.has(id)) log(`  ${id}: not due — skipped (no due DNS observation types; use --force-org to override)`);
    }
  } else if (limit) {
    plannedOrgIds = dueOrgIdsOrdered.slice(0, limit);
  } else if (productionUnbounded) {
    plannedOrgIds = dueOrgIdsOrdered;
  } else {
    const reason = 'refusing to run: neither explicit organisation ids nor --limit was provided (no unbounded full-registry run)';
    log(`OBS-103: ${reason}`);
    return { ok: false, refused: true, reason };
  }

  const classify = deps.classifyOrganisationDnsStates || classifyOrganisationDnsStates;
  const plan = [];
  for (const organisationId of plannedOrgIds) {
    const realDueTypes = dueByOrg.get(organisationId) || [];
    const forced = forceOrg && orgIds.includes(organisationId);
    const typesToProcess = forced ? DNS_OBSERVATION_TYPES : realDueTypes;
    // eslint-disable-next-line no-await-in-loop -- one small lookup per
    // already-selected organisation, never population-wide.
    const classification = await classify(organisationId, realDueTypes, { client });
    plan.push({ organisationId, forced, typesToProcess, classification });
  }

  const cohort = plan.map((p) => p.organisationId);
  log(`OBS-103: cohort = ${cohort.length} organisation(s): ${cohort.join(', ')}`);

  const summary = emptySummary();
  summary.organisationsSelected = plan.length;
  for (const p of plan) {
    summary.statesSelected += p.typesToProcess.length;
    summary.statesSkippedFuture += p.classification.future.length;
    summary.statesSkippedSuspendedOrClaimed += p.classification.suspended.length;
  }

  if (dryRun) {
    log('OBS-103: DRY RUN — no claiming, no collection, no database writes will be performed.');
    for (const p of plan) {
      const tag = p.forced ? ' [FORCED — cadence eligibility bypassed]' : '';
      log(`  ${p.organisationId}${tag}: due=[${p.classification.due.join(',')}] future=[${p.classification.future.join(',')}] suspended=[${p.classification.suspended.join(',')}] would-claim-and-collect=[${p.typesToProcess.join(',')}]`);
    }
    return { ok: true, dryRun: true, cohort, summary, plan };
  }

  const claim = deps.claimDueObservationStates || claimDueObservationStates;
  const observe = deps.observeOrganisationDnsSignals || observeOrganisationDnsSignals;
  const results = [];

  for (const p of plan) {
    const { organisationId, typesToProcess } = p;
    // eslint-disable-next-line no-await-in-loop -- claim then collect must
    // happen in sequence per organisation.
    const claimResult = await claim(organisationId, typesToProcess, { client, now: () => nowIso });
    summary.statesClaimed += claimResult.claimedTypes.length;
    summary.statesSkippedSuspendedOrClaimed += claimResult.skippedTypes.length;

    if (!claimResult.claimed) {
      results.push({ organisationId, skipped: true, reason: 'no requested types could be claimed', skippedTypes: claimResult.skippedTypes });
      log(`  ${organisationId}: skipped — no requested types could be claimed (${claimResult.skippedTypes.map((s) => s.observationType).join(',')})`);
      continue;
    }
    if (claimResult.skippedTypes.length > 0) {
      log(`  ${organisationId}: claimed [${claimResult.claimedTypes.join(',')}], could not claim [${claimResult.skippedTypes.map((s) => s.observationType).join(',')}]`);
    }

    // eslint-disable-next-line no-await-in-loop
    const obsResult = await observe(organisationId, { ...(deps.observeDeps || {}), signalTypes: claimResult.claimedTypes });
    results.push(obsResult);

    if (!obsResult.ok) {
      summary.statesFailed += claimResult.claimedTypes.length;
      log(`  ${organisationId}: no observation attempted — ${obsResult.error}`);
      continue;
    }
    for (const r of obsResult.results) {
      if (r.ok) summary.statesCompleted += 1; else summary.statesFailed += 1;
      log(`  ${organisationId} / ${r.signal}: ${r.ok ? 'observed' : `failed (${r.error})`}`);
    }
  }

  return { ok: true, dryRun: false, cohort, summary, results };
}

module.exports = { runScheduler };
