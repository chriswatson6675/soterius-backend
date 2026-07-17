'use strict';

require('dotenv').config();

// Observation Scheduler CLI — OBS-103. A manual, bounded entrypoint that
// finds due DNS Observation States and invokes the existing OBS-102
// execution path for each due organisation's genuinely due signal subset.
//
// Deliberately NOT a scheduler daemon, NOT a Railway cron target, and NOT
// wired to any recurring trigger — this is a single bounded invocation, run
// by hand or by a future (not-yet-enabled) cron, same as
// run-dns-observation-cli.js (OBS-102) and run-scheduled-sweep-cli.js
// (ENG-032) both already are.
//
// Usage:
//   node observatory/observation-scheduler/run-scheduler-cli.js --limit 10 --dry-run
//   node observatory/observation-scheduler/run-scheduler-cli.js --limit 10
//   node observatory/observation-scheduler/run-scheduler-cli.js --org ORG-abc123 --org ORG-def456
//   node observatory/observation-scheduler/run-scheduler-cli.js --now 2026-07-20T00:00:00.000Z --dry-run
//
// --org restricts selection to the named organisations while PRESERVING due
// eligibility — a named-but-not-due organisation is skipped, not forced.
// --force-org (requires --org) is the explicit, clearly-warned bypass for
// when forcing a non-due organisation is genuinely needed (e.g. a
// supervised corrective re-observation) — never for a recurring scheduler.
//
// --now is permitted ONLY together with --dry-run — a real run always uses
// the real wall clock, so no future-dated claim can ever be stranded.
//
// Refuses to run with neither --org nor --limit given, UNLESS --production
// is explicitly passed too (never the full registry even then — only
// whatever is currently due). This flag is implemented but never enabled by
// this work package — see the OBS-103 final report.

const { runScheduler } = require('./run-scheduler');

function parseArgs(argv) {
  const orgIds = [];
  let limit = null;
  let dryRun = false;
  let now = null;
  let production = false;
  let forceOrg = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--org') { orgIds.push(argv[i + 1]); i += 1; }
    else if (argv[i] === '--limit') { limit = parseInt(argv[i + 1], 10); i += 1; }
    else if (argv[i] === '--dry-run') { dryRun = true; }
    else if (argv[i] === '--now') { now = argv[i + 1]; i += 1; }
    else if (argv[i] === '--production') { production = true; }
    else if (argv[i] === '--force-org') { forceOrg = true; }
  }
  return { orgIds, limit, dryRun, now, production, forceOrg };
}

/**
 * logEnvironmentConfirmation(deps) — same unambiguous confirmation
 * run-dns-observation-cli.js (OBS-102) already prints, reused verbatim in
 * spirit: there is exactly one Supabase project in this stack, documented as
 * PRODUCTION (DEPLOYMENT_CHECKLIST.md §1.5), also backing the pilot release.
 */
function logEnvironmentConfirmation(deps = {}) {
  const log = deps.log || console.log;
  const supabaseUrl = process.env.SUPABASE_URL || '(SUPABASE_URL not set)';
  log(`OBS-103: target environment = ${supabaseUrl}`);
  log('OBS-103: this is the repository\'s single configured Supabase project, documented as PRODUCTION (also backing the pilot release) — no separate dev/staging project exists (DEPLOYMENT_CHECKLIST.md §1.5).');
}

/**
 * run({ orgIds, limit, dryRun, now, production, forceOrg }, deps) — the
 * composable core, independent of argv parsing/process.exit, so it can be
 * tested directly.
 */
async function run({ orgIds = [], limit = null, dryRun = false, now = null, production = false, forceOrg = false } = {}, deps = {}) {
  const log = deps.log || console.log;
  const logEnv = deps.logEnvironmentConfirmation || logEnvironmentConfirmation;
  const scheduler = deps.runScheduler || runScheduler;

  logEnv(deps);

  const outcome = await scheduler({ orgIds, limit, dryRun, now, forceOrg, productionUnbounded: production }, { ...deps, log });

  if (!outcome.ok) return outcome;

  const s = outcome.summary;
  log(`OBS-103: summary — organisations selected ${s.organisationsSelected}, states selected ${s.statesSelected}, claimed ${s.statesClaimed}, completed ${s.statesCompleted}, failed ${s.statesFailed}, skipped-future ${s.statesSkippedFuture}, skipped-suspended-or-claimed ${s.statesSkippedSuspendedOrClaimed}`);
  return outcome;
}

/**
 * exitCodeFor(outcome) → 0 | 1 — the process exit code for a completed
 * run() call. `outcome.ok` alone only tells us the invocation was accepted
 * (not refused for bad args/unbounded execution/etc.) — it stays true even
 * when individual claimed Observation States failed collection,
 * persistence, or quality processing (summary.statesFailed > 0), because
 * runScheduler()'s own result contract deliberately keeps "accepted" and
 * "every state succeeded" as separate facts. A cron/CI caller watching only
 * the process exit code needs both folded together, which is what this does
 * without changing runScheduler()'s own return shape or meaning.
 */
function exitCodeFor(outcome) {
  if (!outcome.ok) return 1;
  if (outcome.summary && outcome.summary.statesFailed > 0) return 1;
  return 0;
}

/* istanbul ignore next -- exercised via this module's exported run(), not this block */
if (require.main === module) {
  const { orgIds, limit, dryRun, now, production, forceOrg } = parseArgs(process.argv.slice(2));
  run({ orgIds, limit, dryRun, now, production, forceOrg }).then((outcome) => {
    process.exit(exitCodeFor(outcome));
  }).catch((err) => {
    console.error('OBS-103: fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, logEnvironmentConfirmation, exitCodeFor };
