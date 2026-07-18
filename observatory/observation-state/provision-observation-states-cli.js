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
// runs a dry-run (plan only) and writes nothing. Batched; restartable; prints
// before/after reconciliation.
//
// THREE MODES — mutually exclusive (legacy full-population is the no-mode default):
//   --limit N          LEGACY (OBS-102). Considers the first N eligible orgs in
//                      authority-enumeration order, skipping already-provisioned
//                      ones only AFTER the slice → cannot guarantee N NEW orgs.
//                      Left unchanged for backward compatibility; DO NOT use it
//                      for a governed controlled-rollout cohort.
//   --cohort-size N    GOVERNED SELECTION (OBS-103). Excludes every already-
//                      provisioned org FIRST, ranks the remainder by
//                      fnv1a32(orgId + ':cohort:v1'), selects the lowest-ranked
//                      N. SELECTION ONLY — it never writes in production; it
//                      emits a reviewed manifest (with an identity digest).
//   --from-manifest P  GOVERNED PRODUCTION WRITE. Provisions ONLY the reviewed
//                      cohort in manifest P, idempotently, after verifying the
//                      digest and refusing on any drift from the live
//                      deterministic selection. Never regenerates or expands.
//
// Governed rollout workflow (BLOCKER-2 remediation):
//   select → manifest → human approval → provision that exact manifest
//
// Usage:
//   node provision-observation-states-cli.js                                   # dry-run, whole eligible population
//   node provision-observation-states-cli.js --cohort-size 100 --manifest phase1a.json   # select → manifest
//   node provision-observation-states-cli.js --from-manifest phase1a.json                # dry-run: validate + reconcile
//   node provision-observation-states-cli.js --from-manifest phase1a.json \
//       --production --confirm PROVISION-STATES --approve-digest <digest>       # governed write

const { provisionObservationStates, enumerateEligibleOrganisations } = require('./provision-states');
const {
  selectCohortByRank, buildCohortManifest, manifestToCsv,
  validateManifest, verifyManifestIdentity, reconcileManifestAgainstLive,
} = require('./cohort-ranking');

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
    fromManifest: null, approveDigest: null, force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--production') out.production = true;
    else if (a === '--force') out.force = true;
    else if (a === '--confirm') { out.confirm = argv[i + 1]; i += 1; }
    else if (a === '--batch-size') { out.batchSize = parseInt(argv[i + 1], 10); i += 1; }
    else if (a === '--limit') { out.limit = parseInt(argv[i + 1], 10); i += 1; }
    else if (a === '--cohort-size') { out.cohortSize = strictInt(argv[i + 1]); i += 1; }
    else if (a === '--manifest') { out.manifest = argv[i + 1]; i += 1; }
    else if (a === '--manifest-format') { out.manifestFormat = argv[i + 1]; i += 1; }
    else if (a === '--from-manifest') { out.fromManifest = argv[i + 1]; i += 1; }
    else if (a === '--approve-digest') { out.approveDigest = argv[i + 1]; i += 1; }
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
    // Overwrite protection: never silently clobber a previously-reviewed
    // manifest (which would hide cohort drift). Require --force to replace.
    const exists = (opts.__existsFile || fs.existsSync);
    if (exists(opts.manifest) && !opts.force) {
      throw new CliValidationError(`manifest path ${opts.manifest} already exists — refusing to overwrite without --force`);
    }
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

  // --cohort-size is SELECTION ONLY. It can never perform a production write:
  // the governed write path is Selection → Manifest → human approval →
  // --from-manifest. This makes it structurally impossible for a production run
  // to regenerate a different cohort than the one that was reviewed.
  if (opts.production) {
    throw new CliValidationError('--cohort-size does not write in production; it produces a reviewed manifest. Provision it with: --from-manifest <path> --production --confirm PROVISION-STATES --approve-digest <digest>');
  }
  const dryRun = true;
  log(`OBS-103 provision: mode = SELECTION (dry-run, no writes); selection = cohort-size ${opts.cohortSize}; batchSize=${opts.batchSize}`);

  const eligible = enumerate(deps);
  const clientDep = deps.client ? { client: deps.client } : {};
  const alreadyProvisionedOrganisationIds = await store.listProvisionedOrganisationIds(clientDep);

  const selection = selectCohortByRank(eligible, {
    size: opts.cohortSize,
    alreadyProvisionedOrganisationIds,
  });

  // Plan only — this path never writes; the plan is what the manifest captures.
  const selectedOrgs = selection.selected.map((s) => ({ organisationId: s.organisationId }));
  const summary = await provision(
    { nowIso: opts.now, batchSize: opts.batchSize, dryRun: true },
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

// GOVERNED PRODUCTION path (--from-manifest). Provisions ONLY the reviewed
// cohort, idempotently, and refuses if the manifest has drifted from the live
// deterministic selection. Never regenerates or expands the cohort.
async function runFromManifest(opts, deps = {}) {
  const log = deps.log || console.log;
  const provision = deps.provisionObservationStates || provisionObservationStates;
  const enumerate = deps.enumerateEligibleOrganisations || enumerateEligibleOrganisations;
  const store = deps.store || require('./store');
  (deps.logEnvironmentConfirmation || logEnvironmentConfirmation)({ log });

  // 1. Load + parse.
  const readFile = opts.__readFile || ((p) => fs.readFileSync(p, 'utf8'));
  let raw;
  try {
    raw = readFile(opts.fromManifest);
  } catch (err) {
    throw new CliValidationError(`cannot read manifest ${opts.fromManifest}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliValidationError(`manifest ${opts.fromManifest} is not valid JSON: ${err.message}`);
  }

  // 2. Validate shape + 3. verify identity (digest + per-entry rank).
  const manifest = validateManifest(parsed);
  verifyManifestIdentity(manifest);
  log(`OBS-103 provision: manifest ${opts.fromManifest} valid — schema ${manifest.schema}, size ${manifest.requestedSize}, entries ${manifest.entries.length}, digest ${manifest.cohortDigest}`);

  const dryRun = resolveMode(opts, log);

  // 4. Human-approval gate for a real write: the operator must echo the exact
  // digest they reviewed, so a swapped/edited file cannot be provisioned even
  // if it is internally consistent.
  if (!dryRun) {
    if (!opts.approveDigest) {
      throw new CliValidationError(`production write from a manifest requires --approve-digest ${manifest.cohortDigest} (the reviewed digest)`);
    }
    if (opts.approveDigest !== manifest.cohortDigest) {
      throw new CliValidationError(`--approve-digest ${opts.approveDigest} does not match the manifest digest ${manifest.cohortDigest} — refusing to provision an unreviewed cohort`);
    }
  }
  log(`OBS-103 provision: mode = ${dryRun ? 'DRY-RUN (no writes)' : 'PRODUCTION WRITE (manifest-pinned)'}`);

  // 5. Reconcile against live state — refuse on drift. This can only refuse,
  //    never expand: the provisioning target is always the manifest's own ids.
  const eligible = enumerate(deps);
  const clientDep = deps.client ? { client: deps.client } : {};
  const provisionedIds = await store.listProvisionedOrganisationIds(clientDep);
  const reconciliation = reconcileManifestAgainstLive(manifest, eligible, provisionedIds);
  if (reconciliation.drift) {
    throw new CliValidationError(`refusing to provision — ${reconciliation.driftReason}. Re-select and obtain a fresh reviewed manifest.`);
  }

  // 6. Idempotent completion of EXACTLY the reviewed cohort. provision() only
  //    creates missing (org,type) rows, so already-complete orgs are no-ops and
  //    partially-provisioned orgs are completed — never expanded beyond the set.
  const targetOrgs = reconciliation.targetOrgIds.map((organisationId) => ({ organisationId }));
  const provisionedSet = new Set(provisionedIds.map(String));
  const alreadyTouched = reconciliation.targetOrgIds.filter((id) => provisionedSet.has(String(id))).length;
  const summary = await provision(
    { nowIso: opts.now, batchSize: opts.batchSize, dryRun },
    { ...deps, eligible: targetOrgs, log },
  );

  log('OBS-103 provision: manifest reconciliation —');
  log(`  reviewed cohort size:            ${manifest.requestedSize}`);
  log(`  manifest organisations:          ${reconciliation.targetOrgIds.length}`);
  log(`  live drift:                      none (matches reviewed manifest)`);
  log(`  manifest orgs already touched:   ${alreadyTouched}`);
  log(`  states already existing:         ${summary.statesExisting}`);
  log(`  organisations already complete:  ${summary.organisationsAlreadyComplete}`);
  log(`  states to create (plan):         ${summary.statesToCreate}`);
  log(`  states created (this run):       ${summary.statesCreated}`);

  return { ok: true, dryRun, mode: 'from-manifest', manifest, reconciliation, summary };
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
  // --limit, --cohort-size and --from-manifest are three distinct contracts;
  // exactly one selection mode may be active (legacy full-population is the
  // no-mode default). Silently combining them would hide which one won.
  const modes = [
    opts.limit != null ? '--limit' : null,
    opts.cohortSize != null ? '--cohort-size' : null,
    opts.fromManifest != null ? '--from-manifest' : null,
  ].filter(Boolean);
  if (modes.length > 1) {
    throw new CliValidationError(`${modes.join(' and ')} are mutually exclusive; use exactly one selection mode`);
  }
  if (opts.fromManifest != null) return runFromManifest(opts, deps);
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
