'use strict';

require('dotenv').config();

// Deployment entrypoint for ENG-032's Scheduled Generation Trigger —
// Operational Deployment Sprint (ENG-044, 2026-07-13).
//
// This is the operational/deployment layer, not Trust Intelligence itself:
// it composes runScheduledSweep() (ENG-032, unmodified) as an opaque
// capability, exactly as ENG-032 §0 requires any caller to, and records a
// summary via sweep-run-metrics.js (also operational, not constitutional).
// Nothing here changes classification, generation, provenance, or scoring.
//
// GOVERNANCE GATE: ENG-032 is registered "Draft — HOLD" in
// DOCUMENT_REGISTER.md as of this writing — its own constitutional review
// has not run, and no Founder override authorising implementation-ahead-of-
// review is recorded for it (unlike ENG-026's precedent for the same
// pattern). Deploying this file or scheduling it in Railway does NOT itself
// authorise production use: this script refuses to do anything unless
// TRUST_PROFILE_SWEEP_ENABLED=true is explicitly set, so a human decision
// gates production execution, not a code deploy.
//
// EXECUTION SAFETY: Railway's own cron semantics (docs.railway.com/cron-jobs)
// already provide run-overlap protection — "if a previous execution is still
// running when the next scheduled execution is due, Railway will skip the
// new cron job" — PROVIDED this process exits cleanly when done. This script
// therefore always terminates via an explicit process.exit(), never relies on
// the event loop draining naturally, so a lingering handle (e.g. a kept-open
// DB connection) can never cause Railway to think a run is still "Active"
// when it has actually finished.
//
// RETRY STRATEGY: no retry loop of its own, by design. A per-Organisation
// failure is already isolated by runScheduledSweep() itself (ENG-032 §5) and
// is automatically retried by the NEXT scheduled invocation, since a failed
// Organisation was never save()'d and therefore remains "stale" per ENG-023
// §12's own current-resolution rule. A crash of the WHOLE sweep invocation
// (e.g. malformed config, population enumeration failure) is recorded via
// recordCrashedRun() and likewise left for the next scheduled run — Railway
// does not automatically retry a failed cron execution, and building an
// in-process retry-the-whole-run loop would risk violating the "never more
// than once per sweep" rule ENG-032 §3 already states for a given wall-clock
// invocation.

const { runScheduledSweep } = require('./scheduled-regeneration');
const { recordCompletedRun, recordCrashedRun } = require('./sweep-run-metrics');
const logger = require('../../infra/utils/logger');

const DEFAULT_POLICY_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function parsePolicyThresholdMs() {
  const raw = process.env.TRUST_PROFILE_SWEEP_POLICY_THRESHOLD_MS;
  if (!raw) return DEFAULT_POLICY_THRESHOLD_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`TRUST_PROFILE_SWEEP_POLICY_THRESHOLD_MS must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

// Bounded manual trial mode (pre-production validation phase, 2026-07-16).
// The first-ever production exercise of this sweep should not default to the
// full ~36,000-organisation population — it should run against a small,
// controlled cohort so its measurements (timing, CH latency, DB query rate,
// success/failure counts) are supervisable. Two mutually exclusive env vars,
// both opt-in and both no-ops when unset (full-population behaviour is
// unchanged): TRUST_PROFILE_SWEEP_TRIAL_ORG_IDS names an explicit,
// reproducible cohort; TRUST_PROFILE_SWEEP_TRIAL_LIMIT takes a deterministic
// prefix of the real population (population order, not random) when hand-
// picking ids isn't practical. Explicit ids take precedence when both are set.
function resolveTrialCohort(realListOrganisationIds) {
  const explicitIdsRaw = process.env.TRUST_PROFILE_SWEEP_TRIAL_ORG_IDS;
  if (explicitIdsRaw) {
    const ids = explicitIdsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) {
      throw new Error('TRUST_PROFILE_SWEEP_TRIAL_ORG_IDS is set but contains no organisation ids');
    }
    return { active: true, description: `${ids.length} explicit organisation id(s)`, listOrganisationIds: async () => ids };
  }

  const limitRaw = process.env.TRUST_PROFILE_SWEEP_TRIAL_LIMIT;
  if (limitRaw) {
    const limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(limit)) {
      throw new Error(`TRUST_PROFILE_SWEEP_TRIAL_LIMIT must be a positive integer, got ${JSON.stringify(limitRaw)}`);
    }
    return {
      active: true,
      description: `first ${limit} organisation(s) of the full population`,
      listOrganisationIds: async () => (await realListOrganisationIds()).slice(0, limit),
    };
  }

  return { active: false, description: null, listOrganisationIds: realListOrganisationIds };
}

async function main({ deps = {} } = {}) {
  const enabled = deps.enabled !== undefined ? deps.enabled : process.env.TRUST_PROFILE_SWEEP_ENABLED === 'true';
  if (!enabled) {
    logger.info('scheduled sweep CLI: TRUST_PROFILE_SWEEP_ENABLED is not "true" — no-op by design (ENG-032 remains Draft/HOLD pending a Founder decision; see ENG-044). Exiting 0.');
    return { skipped: true };
  }

  // Test injection (deps.listOrganisationIds) always wins outright — trial-
  // mode env vars only ever apply to the real, non-injected population source.
  const injectedListOrganisationIds = deps.listOrganisationIds;
  const runSweep = deps.runScheduledSweep || runScheduledSweep;
  const recordCompleted = deps.recordCompletedRun || recordCompletedRun;
  const recordCrashed = deps.recordCrashedRun || recordCrashedRun;
  const now = deps.now || (() => new Date().toISOString());

  const startedAt = now();

  // Everything from here on — a bad TRUST_PROFILE_SWEEP_POLICY_THRESHOLD_MS or
  // TRUST_PROFILE_SWEEP_TRIAL_* value included — is recorded as a crashed run
  // on failure, so the metrics table is a complete record of every invocation
  // attempt, not just ones that got as far as calling runScheduledSweep() itself.
  let policyThresholdMs;
  try {
    policyThresholdMs = parsePolicyThresholdMs();

    const trial = injectedListOrganisationIds
      ? { active: false, description: null, listOrganisationIds: injectedListOrganisationIds }
      : resolveTrialCohort(require('../../organisation/resolve').listOrganisationIds);
    const listOrganisationIds = trial.listOrganisationIds;
    if (trial.active) {
      logger.info(`scheduled sweep CLI: TRIAL MODE ACTIVE — cohort = ${trial.description}. This is NOT a full-population run.`);
    }

    let populationTotal;
    try {
      populationTotal = (await listOrganisationIds()).length;
    } catch (cause) {
      populationTotal = null; // best-effort only — never blocks the sweep itself
    }

    // listOrganisationIds is forwarded explicitly so the actual sweep
    // operates on the exact same cohort populationTotal was just computed
    // from (trial-restricted or full, matching either way) rather than the
    // real runScheduledSweep silently re-resolving the full population itself.
    const result = await runSweep({ policyThresholdMs, deps: { listOrganisationIds } });
    const completedAt = now();
    logger.info(`scheduled sweep CLI: completed — ${result.processed.length} processed, ${result.skipped.length} skipped, ${result.failed.length} failed`);
    await recordCompleted({ startedAt, completedAt, policyThresholdMs, populationTotal, result });
    return { skipped: false, result };
  } catch (cause) {
    const crashedAt = now();
    logger.error(`scheduled sweep CLI: the sweep invocation itself crashed — ${cause.message}`);
    await recordCrashed({ startedAt, crashedAt, policyThresholdMs: policyThresholdMs ?? null, reason: cause.message });
    throw cause;
  }
}

/* istanbul ignore next -- exercised via run-scheduled-sweep-cli.test.js's exported main(), not this block */
if (require.main === module) {
  main()
    .then((outcome) => {
      // Per-Organisation failures are already isolated/logged/persisted above
      // — a non-zero exit here is reserved for "the sweep invocation itself
      // never completed", not "some Organisations failed within it".
      process.exit(0);
    })
    .catch((err) => {
      logger.error(`scheduled sweep CLI: exiting 1 — ${err.stack || err.message}`);
      process.exit(1);
    });
}

module.exports = { main };
