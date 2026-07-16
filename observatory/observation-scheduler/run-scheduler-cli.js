'use strict';

require('dotenv').config();

// Observation Scheduler CLI — OBS-103. A manual, bounded entrypoint that
// finds due DNS Observation States and invokes the existing OBS-102
// execution path for each due organisation.
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
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--org') { orgIds.push(argv[i + 1]); i += 1; }
    else if (argv[i] === '--limit') { limit = parseInt(argv[i + 1], 10); i += 1; }
    else if (argv[i] === '--dry-run') { dryRun = true; }
    else if (argv[i] === '--now') { now = argv[i + 1]; i += 1; }
    else if (argv[i] === '--production') { production = true; }
  }
  return { orgIds, limit, dryRun, now, production };
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
 * run({ orgIds, limit, dryRun, now, production }, deps) — the composable
 * core, independent of argv parsing/process.exit, so it can be tested
 * directly.
 */
async function run({ orgIds = [], limit = null, dryRun = false, now = null, production = false } = {}, deps = {}) {
  const log = deps.log || console.log;
  const logEnv = deps.logEnvironmentConfirmation || logEnvironmentConfirmation;
  const scheduler = deps.runScheduler || runScheduler;

  logEnv(deps);

  const outcome = await scheduler({ orgIds, limit, dryRun, now, productionUnbounded: production }, { ...deps, log });

  if (!outcome.ok) return outcome;

  log(`OBS-103: summary — selected ${outcome.summary.selected}, claimed ${outcome.summary.claimed}, completed ${outcome.summary.completed}, failed ${outcome.summary.failed}, skipped ${outcome.summary.skipped}`);
  return outcome;
}

/* istanbul ignore next -- exercised via this module's exported run(), not this block */
if (require.main === module) {
  const { orgIds, limit, dryRun, now, production } = parseArgs(process.argv.slice(2));
  run({ orgIds, limit, dryRun, now, production }).then((outcome) => {
    process.exit(outcome.ok ? 0 : 1);
  }).catch((err) => {
    console.error('OBS-103: fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, logEnvironmentConfirmation };
