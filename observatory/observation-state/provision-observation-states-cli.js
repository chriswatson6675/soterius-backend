'use strict';

require('dotenv').config();

const fs = require('node:fs');

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
// TWO SELECTION MODES — mutually exclusive:
//   --limit N        LEGACY (OBS-102). Considers the first N eligible orgs in
//                    authority-enumeration order, skipping already-provisioned
//                    ones only AFTER the slice → cannot guarantee N NEW orgs.
//                    Left unchanged for backward compatibility; DO NOT use it
//                    for a governed controlled-rollout cohort.
//   --cohort-size N  GOVERNED (OBS-103 controlled rollout). Excludes every
//                    already-provisioned organisation FIRST, then deterministic-
//                    ally ranks the remainder by fnv1a32(orgId + ':cohort:v1')
//                    and selects the lowest-ranked N → exactly N NEW orgs (or all
//                    remaining if fewer than N). Reproducible and cumulative.
//
// Usage:
//   node provision-observation-states-cli.js                                   # dry-run, whole eligible population
//   node provision-observation-states-cli.js --cohort-size 100                 # dry-run, deterministic top-100 NEW
//   node provision-observation-states-cli.js --cohort-size 100 --manifest cohort.json
//   node provision-observation-states-cli.js --cohort-size 100 --production --confirm PROVISION-STATES

const { provisionObservationStates, enumerateEligibleOrganisations } = require('./provision-states');
const { selectCohortByRank, buildCohortManifest, manifestToCsv } = require('./cohort-ranking');

const CONFIRM_TOKEN = 'PROVISION-STATES';
const DAILY_TYPES = ['spf', 'dkim', 'dmarc'];
const WEEKLY_TYPES = ['dnssec', 'caa'];

// Strict integer parse: unlike parseInt, rejects '3.5' / 'abc' / '' by yielding
// NaN, so a non-integer --cohort-size fails validation instead of being silently
// truncated.
function strictInt(raw) {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) return NaN;
  return parseInt(raw, 10);
}

function parseArgs(argv) {
  const out = {
    production: false, confirm: null, batchSize: 500, limit: null, now: null,
    cohortSize: null, manifest: null, manifestFormat: 'json',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--production') out.production = true;
    else if (a === '--confirm') { out.confirm = argv[i + 1]; i += 1; }
    else if (a === '--batch-size') { out.batchSize = parseInt(argv[i + 1], 10); i += 1; }
    else if (a === '--limit') { out.limit = parseInt(argv[i + 1], 10); i += 1; }
    else if (a === '--cohort-size') { out.cohortSize = strictInt(argv[i + 1]); i += 1; }
    else if (a === '--manifest') { out.manifest = argv[i + 1]; i += 1; }
    else if (a === '--manifest-format') { out.manifestFormat = argv[i + 1]; i += 1; }
    else if (a === '--now') { out.now = argv[i + 1]; i += 1; }
  }
  return out;
}

class CliValidationError extends Error {
  constructor(message) { super(message); this.name = 'CliValidationError'; }
}

function logEnvironmentConfirmation(deps = {}) {
  const log = deps.log || console.log;
  log(`OBS-103 provision: target environment = ${process.env.SUPABASE_URL || '(SUPABASE_URL not set)'}`);
  log('OBS-103 provision: single configured Supabase project, documented as PRODUCTION (DEPLOYMENT_CHECKLIST.md §1.5).');
}

function resolveMode(opts, log) {
  const wantsWrite = opts.production === true;
  const confirmed = opts.confirm === CONFIRM_TOKEN;
  const dryRun = !(wantsWrite && confirmed);
  if (wantsWrite && !confirmed) {
    log(`OBS-103 provision: --production given WITHOUT --confirm ${CONFIRM_TOKEN} → refusing to write; running dry-run instead.`);
  }
  return dryRun;
}

function emitManifest(manifest, opts, log) {
  const format = (opts.manifestFormat || 'json').toLowerCase();
  if (format !== 'json' && format !== 'csv') {
    throw new CliValidationError(`--manifest-format must be json or csv, got "${opts.manifestFormat}"`);
  }
  const body = format === 'csv' ? manifestToCsv(manifest) : `${JSON.stringify(manifest, null, 2)}\n`;
  if (opts.manifest) {
    const write = (opts.__writeFile) || fs.writeFileSync;
    write(opts.manifest, body);
    log(`OBS-103 provision: cohort manifest (${format}) written to ${opts.manifest}`);
  } else {
    // Always provide a machine-readable manifest for review even without a path.
    log(`--- OBS-103 COHORT MANIFEST (${format.toUpperCase()}) ---`);
    log(body.trimEnd());
    log('--- END COHORT MANIFEST ---');
  }
}

// GOVERNED controlled-rollout path (--cohort-size).
async function runCohort(opts, deps = {}) {
  const log = deps.log || console.log;
  const provision = deps.provisionObservationStates || provisionObservationStates;
  const enumerate = deps.enumerateEligibleOrganisations || enumerateEligibleOrganisations;
  const store = deps.store || require('./store');
  (deps.logEnvironmentConfirmation || logEnvironmentConfirmation)({ log });

  const dryRun = resolveMode(opts, log);
  log(`OBS-103 provision: mode = ${dryRun ? 'DRY-RUN (no writes)' : 'PRODUCTION WRITE'}; selection = cohort-size ${opts.cohortSize}; batchSize=${opts.batchSize}`);

  const eligible = enumerate(deps);
  const clientDep = deps.client ? { client: deps.client } : {};
  const alreadyProvisionedOrganisationIds = await store.listProvisionedOrganisationIds(clientDep);

  const selection = selectCohortByRank(eligible, {
    size: opts.cohortSize,
    alreadyProvisionedOrganisationIds,
  });

  // Provision EXACTLY the deterministically selected set — never the full
  // population and never an authority-order slice.
  const selectedOrgs = selection.selected.map((s) => ({ organisationId: s.organisationId }));
  const summary = await provision(
    { nowIso: opts.now, batchSize: opts.batchSize, dryRun },
    { ...deps, eligible: selectedOrgs, log },
  );

  const proposedDaily = selection.selectedCount * DAILY_TYPES.length;
  const proposedWeekly = selection.selectedCount * WEEKLY_TYPES.length;

  log('OBS-103 provision: cohort selection —');
  log(`  requested cohort size:            ${selection.requestedSize}`);
  log(`  eligible organisations:           ${selection.eligibleCount}`);
  log(`  already-provisioned (excluded):   ${selection.alreadyProvisionedCount}`);
  log(`  eligible-unprovisioned:           ${selection.eligibleUnprovisionedCount}`);
  log(`  selected organisations:           ${selection.selectedCount}`);
  log(`  proposed states:                  ${summary.statesToCreate}`);
  log(`  proposed daily states:            ${proposedDaily} (${DAILY_TYPES.join('/')})`);
  log(`  proposed weekly states:           ${proposedWeekly} (${WEEKLY_TYPES.join('/')})`);
  log(`  lowest selected rank:             ${selection.lowestRank}`);
  log(`  highest selected rank:            ${selection.highestRank}`);
  log(`  sufficient eligible-unprovisioned:${selection.sufficient ? ' yes' : ` NO (only ${selection.eligibleUnprovisionedCount} available)`}`);
  log(`  states created (this run):        ${summary.statesCreated}`);

  const manifest = buildCohortManifest(selection);
  emitManifest(manifest, opts, log);

  return {
    ok: true,
    dryRun,
    mode: 'cohort',
    selection,
    summary,
    proposedDaily,
    proposedWeekly,
    manifest,
  };
}

// LEGACY path (--limit / full population) — semantics unchanged.
async function runLegacy(opts, deps = {}) {
  const log = deps.log || console.log;
  const provision = deps.provisionObservationStates || provisionObservationStates;
  (deps.logEnvironmentConfirmation || logEnvironmentConfirmation)({ log });

  const dryRun = resolveMode(opts, log);
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
  return { ok: true, dryRun, mode: 'legacy', summary };
}

async function run(opts, deps = {}) {
  // --limit and --cohort-size are mutually exclusive: they are two different
  // selection contracts and silently combining them would hide which one won.
  if (opts.limit != null && opts.cohortSize != null) {
    throw new CliValidationError('--limit and --cohort-size are mutually exclusive; use exactly one selection mode');
  }
  if (opts.cohortSize != null) return runCohort(opts, deps);
  return runLegacy(opts, deps);
}

/* istanbul ignore next -- exercised via run() */
if (require.main === module) {
  run(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => { console.error('OBS-103 provision: fatal error:', err.message); process.exit(1); });
}

module.exports = {
  run, parseArgs, logEnvironmentConfirmation, enumerateEligibleOrganisations,
  CONFIRM_TOKEN, CliValidationError, strictInt,
};
