'use strict';

require('dotenv').config();

// Observation State provisioning CLI — OBS-103 (full-coverage transition).
//
// Idempotently provisions the five DNS observation states for every eligible
// organisation (exactly one verified, uncontested, resolvable domain), with
// initial next_due_at derived from the deterministic UTC shard policy.
//
// SAFETY: dry-run is the DEFAULT. A real write requires BOTH an explicit
// --production flag AND --confirm PROVISION-STATES. Without both, the command
// runs a dry-run (plan only) and writes nothing. Batched; restartable (a rerun
// resumes, skipping already-provisioned organisations); prints before/after
// reconciliation.
//
// Usage:
//   node provision-observation-states-cli.js                       # dry-run, whole eligible population
//   node provision-observation-states-cli.js --limit 100           # dry-run, first 100
//   node provision-observation-states-cli.js --production --confirm PROVISION-STATES --batch-size 500

const { provisionObservationStates, enumerateEligibleOrganisations } = require('./provision-states');

const CONFIRM_TOKEN = 'PROVISION-STATES';

function parseArgs(argv) {
  const out = { production: false, confirm: null, batchSize: 500, limit: null, now: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--production') out.production = true;
    else if (a === '--confirm') { out.confirm = argv[i + 1]; i += 1; }
    else if (a === '--batch-size') { out.batchSize = parseInt(argv[i + 1], 10); i += 1; }
    else if (a === '--limit') { out.limit = parseInt(argv[i + 1], 10); i += 1; }
    else if (a === '--now') { out.now = argv[i + 1]; i += 1; }
  }
  return out;
}

function logEnvironmentConfirmation(deps = {}) {
  const log = deps.log || console.log;
  log(`OBS-103 provision: target environment = ${process.env.SUPABASE_URL || '(SUPABASE_URL not set)'}`);
  log('OBS-103 provision: single configured Supabase project, documented as PRODUCTION (DEPLOYMENT_CHECKLIST.md §1.5).');
}

async function run(opts, deps = {}) {
  const log = deps.log || console.log;
  const provision = deps.provisionObservationStates || provisionObservationStates;
  (deps.logEnvironmentConfirmation || logEnvironmentConfirmation)({ log });

  const wantsWrite = opts.production === true;
  const confirmed = opts.confirm === CONFIRM_TOKEN;
  const dryRun = !(wantsWrite && confirmed);

  if (wantsWrite && !confirmed) {
    log(`OBS-103 provision: --production given WITHOUT --confirm ${CONFIRM_TOKEN} → refusing to write; running dry-run instead.`);
  }
  log(`OBS-103 provision: mode = ${dryRun ? 'DRY-RUN (no writes)' : 'PRODUCTION WRITE'}; batchSize=${opts.batchSize}${opts.limit ? ` limit=${opts.limit}` : ''}`);

  const summary = await provision(
    { nowIso: opts.now, batchSize: opts.batchSize, limit: opts.limit, dryRun },
    { ...deps, log },
  );

  log('OBS-103 provision: reconciliation —');
  log(`  eligible organisations:        ${summary.eligibleOrganisations}`);
  log(`  considered this run:           ${summary.consideredOrganisations}`);
  log(`  organisations already complete:${summary.organisationsAlreadyComplete}`);
  log(`  states already existing:       ${summary.statesExisting}`);
  log(`  states to create (plan):       ${summary.statesToCreate}`);
  log(`  states created (this run):     ${summary.statesCreated}`);
  log(`  expected full-population total: ${summary.eligibleOrganisations * 5} (5 × eligible)`);
  return { ok: true, dryRun, summary };
}

/* istanbul ignore next -- exercised via run() */
if (require.main === module) {
  run(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => { console.error('OBS-103 provision: fatal error:', err.message); process.exit(1); });
}

module.exports = { run, parseArgs, logEnvironmentConfirmation, enumerateEligibleOrganisations, CONFIRM_TOKEN };
