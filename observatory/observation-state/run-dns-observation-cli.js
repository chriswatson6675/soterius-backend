'use strict';

require('dotenv').config();

// DNS Observation Integration CLI — OBS-102. A manual, bounded entrypoint for
// running the five DNS-based Observation types against an explicit cohort of
// organisations. Deliberately NOT a scheduler, NOT a Railway cron target, and
// NOT wired to any recurring trigger — see run-scheduled-sweep-cli.js for the
// (also not-yet-enabled) population-wide sweep; this is a separate, narrower,
// manual tool for OBS-102's own bounded validation needs.
//
// Usage:
//   node observatory/observation-state/run-dns-observation-cli.js --org ORG-abc123 --dry-run
//   node observatory/observation-state/run-dns-observation-cli.js --org ORG-abc123 --org ORG-def456
//   node observatory/observation-state/run-dns-observation-cli.js --limit 5 --dry-run
//
// Refuses to run with neither --org nor --limit given (see cohort-selection.js's
// UnboundedRunRefusedError) — there is no flag or default that runs the full
// organisation registry.

const { selectCohort, UnboundedRunRefusedError } = require('./cohort-selection');
const { observeOrganisationDnsSignals } = require('./observe-organisation');

function parseArgs(argv) {
  const orgIds = [];
  let limit = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--org') { orgIds.push(argv[i + 1]); i += 1; }
    else if (argv[i] === '--limit') { limit = parseInt(argv[i + 1], 10); i += 1; }
    else if (argv[i] === '--dry-run') { dryRun = true; }
  }
  return { orgIds, limit, dryRun };
}

/**
 * logEnvironmentConfirmation(deps) — an unambiguous, unskippable log line
 * naming which Supabase project this run targets. Per DEPLOYMENT_CHECKLIST.md
 * §1.5 (confirmed 2026-07-13) there is exactly one Supabase project in this
 * stack, and it is the repository's own documented PRODUCTION project
 * (also backing the pilot release, RELEASE-001) — there is no separate
 * staging/dev project to fall back to. This is stated here plainly rather
 * than silently assumed.
 */
function logEnvironmentConfirmation(deps = {}) {
  const log = deps.log || console.log;
  const supabaseUrl = process.env.SUPABASE_URL || '(SUPABASE_URL not set)';
  log(`OBS-102: target environment = ${supabaseUrl}`);
  log('OBS-102: this is the repository\'s single configured Supabase project, documented as PRODUCTION (also backing the pilot release) — no separate dev/staging project exists (DEPLOYMENT_CHECKLIST.md §1.5).');
}

/**
 * run({ orgIds, limit, dryRun }, deps) — the composable core, independent of
 * argv parsing/process.exit, so it can be tested directly.
 */
async function run({ orgIds = [], limit = null, dryRun = false } = {}, deps = {}) {
  const log = deps.log || console.log;
  const listOrganisationIds = deps.listOrganisationIds || (() => require('../../organisation/resolve').listOrganisationIds());
  const observe = deps.observeOrganisationDnsSignals || observeOrganisationDnsSignals;
  const logEnv = deps.logEnvironmentConfirmation || logEnvironmentConfirmation;

  logEnv(deps);

  let cohort;
  try {
    cohort = selectCohort({ explicitIds: orgIds, limit }, orgIds.length ? [] : await listOrganisationIds());
  } catch (err) {
    if (err instanceof UnboundedRunRefusedError) {
      log(`OBS-102: ${err.message}`);
      return { ok: false, refused: true, reason: err.message };
    }
    throw err;
  }

  log(`OBS-102: cohort = ${cohort.length} organisation(s): ${cohort.join(', ')}`);

  if (dryRun) {
    log('OBS-102: DRY RUN — no collection, no database writes will be performed.');
    for (const organisationId of cohort) {
      log(`  would observe: ${organisationId} -> spf, dkim, dmarc, dnssec, caa`);
    }
    return { ok: true, dryRun: true, cohort };
  }

  const results = [];
  for (const organisationId of cohort) {
    log(`OBS-102: observing ${organisationId}...`);
    const result = await observe(organisationId, deps.observeDeps || {});
    results.push(result);
    if (!result.ok) {
      log(`  ${organisationId}: no observation attempted — ${result.error}`);
    } else {
      for (const r of result.results) {
        const childWarning = r.ok && r.childError ? ` [WARNING: supplementary evidence did not persist: ${r.childError}]` : '';
        log(`  ${organisationId} / ${r.signal}: ${r.ok ? 'observed' : `failed (${r.error})`}${childWarning}`);
      }
    }
  }

  return { ok: true, dryRun: false, cohort, results };
}

/* istanbul ignore next -- exercised via this module's exported run(), not this block */
if (require.main === module) {
  const { orgIds, limit, dryRun } = parseArgs(process.argv.slice(2));
  run({ orgIds, limit, dryRun }).then((outcome) => {
    process.exit(outcome.ok ? 0 : 1);
  }).catch((err) => {
    console.error('OBS-102: fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, logEnvironmentConfirmation };
