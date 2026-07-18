'use strict';

require('dotenv').config();

// Full-population draining scheduler CLI — OBS-103 (full-coverage transition).
//
// The intended eventual PRODUCTION entrypoint, invoked by the Railway cron
// (*/15 * * * *). Each invocation drains DUE observation states page by page up
// to an explicit work/runtime budget, then exits — leaving remaining work due
// for the next 15-minute wake. It processes whatever is due (no --org scope);
// run-scheduler-cli.js remains the targeted tool for local testing, controlled
// cohorts, single-organisation diagnosis, and incident response.
//
// Requires --production to actually run, so a bare invocation never scans by
// accident. --now (a fixed invocation instant) is permitted only with --dry-run.
//
// Usage (intended production):
//   node observatory/observation-scheduler/run-drain-cli.js --production \
//     --max-states-per-run 1500 --page-size 250 --concurrency 8 --runtime-budget-ms 720000

const { drainDueStates, DEFAULT_MAX_STATES_PER_RUN, DEFAULT_CONCURRENCY, DEFAULT_RUNTIME_BUDGET_MS } = require('./drain');
const { DEFAULT_PAGE_SIZE } = require('./due-selection');

function parseArgs(argv) {
  const out = {
    production: false, dryRun: false, now: null,
    maxStatesPerRun: DEFAULT_MAX_STATES_PER_RUN, pageSize: DEFAULT_PAGE_SIZE,
    concurrency: DEFAULT_CONCURRENCY, runtimeBudgetMs: DEFAULT_RUNTIME_BUDGET_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--production') out.production = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--now') { out.now = argv[i + 1]; i += 1; }
    else if (a === '--max-states-per-run') { out.maxStatesPerRun = parseInt(argv[i + 1], 10); i += 1; }
    else if (a === '--page-size') { out.pageSize = parseInt(argv[i + 1], 10); i += 1; }
    else if (a === '--concurrency') { out.concurrency = parseInt(argv[i + 1], 10); i += 1; }
    else if (a === '--runtime-budget-ms') { out.runtimeBudgetMs = parseInt(argv[i + 1], 10); i += 1; }
  }
  return out;
}

function logEnvironmentConfirmation(deps = {}) {
  const log = deps.log || console.log;
  log(`OBS-103 drain: target environment = ${process.env.SUPABASE_URL || '(SUPABASE_URL not set)'}`);
  log('OBS-103 drain: single configured Supabase project, documented as PRODUCTION (DEPLOYMENT_CHECKLIST.md §1.5).');
}

async function run(opts, deps = {}) {
  const log = deps.log || console.log;
  const drain = deps.drainDueStates || drainDueStates;
  (deps.logEnvironmentConfirmation || logEnvironmentConfirmation)({ log });

  if (opts.now && !opts.dryRun) {
    const reason = '--now is only permitted together with --dry-run.';
    log(`OBS-103 drain: refused — ${reason}`);
    return { ok: false, refused: true, reason };
  }
  if (!opts.production && !opts.dryRun) {
    const reason = 'refusing to run: pass --production to drain due states (or --dry-run for a no-op preview).';
    log(`OBS-103 drain: ${reason}`);
    return { ok: false, refused: true, reason };
  }
  if (opts.dryRun) {
    // A genuine no-op: report the parameters and stop without claiming anything.
    log(`OBS-103 drain: DRY RUN — would drain with pageSize=${opts.pageSize} maxStatesPerRun=${opts.maxStatesPerRun} concurrency=${opts.concurrency} runtimeBudgetMs=${opts.runtimeBudgetMs}; no claims, no writes.`);
    return { ok: true, dryRun: true };
  }

  const summary = await drain({
    now: opts.now, pageSize: opts.pageSize, maxStatesPerRun: opts.maxStatesPerRun,
    concurrency: opts.concurrency, runtimeBudgetMs: opts.runtimeBudgetMs,
  }, { ...deps, log });
  log(`OBS-103 drain: summary — pages ${summary.pagesFetched}, seen ${summary.statesSeen}, orgs ${summary.orgsProcessed}, claimed ${summary.statesClaimed}, completed ${summary.statesCompleted}, failed ${summary.statesFailed}, skipped ${summary.statesSkipped}, stopped=${summary.stoppedReason}`);
  return { ok: true, summary };
}

// Exit 0 for any COMPLETED drain, even with statesFailed > 0. Per-observation
// failures (DNS timeouts, etc.) are normal, recorded outcomes that reschedule as
// retries — they are NOT process failures. Under Railway's restartPolicy
// ON_FAILURE, exiting non-zero on a partial data failure would restart the whole
// drain (up to maxRetries times) every wake during any outage — a restart storm
// that multiplies DNS load. Only a refusal (bad args / missing --production) or a
// thrown fatal error (the CLI's .catch) exits non-zero.
function exitCodeFor(outcome) {
  return outcome.ok ? 0 : 1;
}

/* istanbul ignore next -- exercised via run() */
if (require.main === module) {
  run(parseArgs(process.argv.slice(2)))
    .then((o) => process.exit(exitCodeFor(o)))
    .catch((err) => { console.error('OBS-103 drain: fatal error:', err.message); process.exit(1); });
}

module.exports = { run, parseArgs, exitCodeFor, logEnvironmentConfirmation };
