'use strict';

// Observation Scheduler — OBS-103.
//
// Finds due Observation States (the five DNS types only), groups them by
// organisation, claims each due organisation's full DNS batch, and invokes
// the existing, unmodified OBS-102 execution path
// (observeOrganisationDnsSignals) once per claimed organisation.
//
// ALL FIVE DNS SIGNALS PER DUE ORGANISATION, NOT ONLY THE DUE ONES (v1
// decision — see the assessment in the OBS-103 final report): OBS-102's
// observeOrganisationDnsSignals() has no per-signal filter parameter, and
// this work package deliberately does not add one — that would mean
// modifying the just-approved production execution path to serve a v1
// convenience, which is a larger risk than the actual cost of re-checking a
// handful of DNS lookups. The signals share similar (daily/weekly) cadences,
// so the common case is that most of an organisation's five are due close
// together anyway. This can be revisited in a future work package without
// changing OBS-103's own contract, if the cost profile ever changes.
//
// Never generates a Trust Profile, never calls Companies House/FCA/SRA — it
// only ever calls observeOrganisationDnsSignals, which already excludes all
// of that (OBS-102, unchanged).
//
// Not a cron, not a Railway service, not a persistent worker — a single bounded
// invocation, same shape as OBS-102's own CLI.

const { findDueCandidates, groupByOrganisation } = require('./due-selection');
const { claimOrganisationDnsStates } = require('./claim');
const { observeOrganisationDnsSignals } = require('../observation-state/observe-organisation');
const { selectCohort, UnboundedRunRefusedError } = require('../observation-state/cohort-selection');

function getClient() { return require('../../infra/database').getClient(); }

/**
 * runScheduler({ orgIds, limit, dryRun, now, productionUnbounded }, deps) →
 *   { ok: false, refused: true, reason }
 *   | { ok: true, dryRun: true, cohort, summary }
 *   | { ok: true, dryRun: false, cohort, summary, results }
 *
 * Bounding rules (reusing OBS-102's own cohort-selection.js verbatim):
 *   - explicit orgIds → used exactly as given, regardless of due-ness (an
 *     operator-selected cohort, same contract OBS-102's own CLI already has).
 *   - --limit with no explicit ids → deterministically takes the first N
 *     due organisations (soonest-due-first), not the whole due set.
 *   - neither → refused, UNLESS productionUnbounded is explicitly set, in
 *     which case every currently-due organisation runs (still never the full
 *     registry — only whatever due-selection actually finds) — this flag is
 *     built but never enabled by this work package (see the final report).
 */
async function runScheduler({ orgIds = [], limit = null, dryRun = false, now, productionUnbounded = false } = {}, deps = {}) {
  const log = deps.log || (() => {});
  const client = deps.client || getClient();
  const nowIso = now || new Date().toISOString();

  const findCandidates = deps.findDueCandidates || findDueCandidates;
  const candidates = await findCandidates({ now: nowIso }, { client });
  const dueOrgIds = groupByOrganisation(candidates);

  log(`OBS-103: ${candidates.length} due (organisation, signal) candidate(s) across ${dueOrgIds.length} organisation(s)`);

  let cohort;
  try {
    cohort = selectCohort({ explicitIds: orgIds, limit }, dueOrgIds);
  } catch (err) {
    if (err instanceof UnboundedRunRefusedError) {
      if (!productionUnbounded) {
        log(`OBS-103: ${err.message}`);
        return { ok: false, refused: true, reason: err.message };
      }
      // Explicit production flag: every currently-due organisation, never
      // the full registry — dueOrgIds is already scoped to what's due.
      cohort = dueOrgIds;
    } else {
      throw err;
    }
  }

  log(`OBS-103: cohort = ${cohort.length} organisation(s): ${cohort.join(', ')}`);

  const summary = { selected: cohort.length, claimed: 0, completed: 0, failed: 0, skipped: 0 };

  if (dryRun) {
    log('OBS-103: DRY RUN — no claiming, no collection, no database writes will be performed.');
    for (const organisationId of cohort) {
      log(`  would claim + observe: ${organisationId} -> spf, dkim, dmarc, dnssec, caa`);
    }
    return { ok: true, dryRun: true, cohort, summary };
  }

  const claim = deps.claimOrganisationDnsStates || claimOrganisationDnsStates;
  const observe = deps.observeOrganisationDnsSignals || observeOrganisationDnsSignals;
  const results = [];

  for (const organisationId of cohort) {
    // eslint-disable-next-line no-await-in-loop -- claims and their
    // subsequent collection must happen in sequence per organisation.
    const claimResult = await claim(organisationId, { client, now: () => nowIso });
    if (!claimResult.claimed) {
      summary.skipped += 1;
      results.push({ organisationId, skipped: true, reason: claimResult.reason });
      log(`  ${organisationId}: skipped — ${claimResult.reason}`);
      continue;
    }
    summary.claimed += 1;

    // eslint-disable-next-line no-await-in-loop
    const obsResult = await observe(organisationId, deps.observeDeps || {});
    results.push(obsResult);

    if (!obsResult.ok) {
      summary.failed += 1;
      log(`  ${organisationId}: no observation attempted — ${obsResult.error}`);
      continue;
    }
    const anySignalFailed = obsResult.results.some((r) => !r.ok);
    if (anySignalFailed) summary.failed += 1; else summary.completed += 1;
    for (const r of obsResult.results) {
      log(`  ${organisationId} / ${r.signal}: ${r.ok ? 'observed' : `failed (${r.error})`}`);
    }
  }

  return { ok: true, dryRun: false, cohort, summary, results };
}

module.exports = { runScheduler };
