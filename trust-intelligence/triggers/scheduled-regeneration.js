'use strict';

// Scheduled Generation Trigger — ENG-032 (Approved, ENG-014 WP-5).
//
// Thin, population-scoped iteration and triggering layer. Performs no
// observation, identity resolution, provenance construction, scoring, or
// Trust Profile assembly (ENG-032 §0) — every constitutionally significant
// act is delegated to generate-trust-profile.js (ENG-029), invoked as an
// opaque capability. This module only decides which Organisations are stale
// and calls that capability once per stale Organisation, per sweep.
//
// Explicitly excludes change-detection/redundant-regeneration avoidance
// (ENG-014 WP-9) — every stale Organisation is regenerated in full, every
// sweep, an accepted interim compute-cost characteristic (ENG-014 R-6).

class SweepMalformedConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SweepMalformedConfigError';
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * runScheduledSweep({ policyThresholdMs, deps }) → Promise<{
 *   processed: Array<{ organisationId, generatedAt }>,
 *   skipped: Array<{ organisationId, reason }>,
 *   failed: Array<{ organisationId, reason }>,
 * }>
 *
 * deps (all optional, defaulting to the canonical capabilities):
 *   listOrganisationIds() → string[]                        (population)
 *   getCurrent(organisationId) → { exists, generatedAt? }   (ENG-023 §12 contract)
 *   generateTrustProfile(organisationId, { trigger, generatedAt }) → instance
 *   save(instance)                                          (WP-9 persistence)
 *   now() → string (ISO-8601)  — the sweep's own execution-time reading,
 *     read once per classification and once per generation call (ENG-032 §6);
 *     injectable so tests hold this input fixed rather than reading a real
 *     clock (closing the ENG-032 WP-5A review's Finding 1 gap).
 *   logger — {info, warn, error}, defaults to infra/utils/logger.js. Purely
 *     operational visibility (Implementation Readiness Sprint, 2026-07-13):
 *     a full-population sweep runs unattended for hours with no other
 *     progress signal, so this is the one place that observation happens.
 *     Never affects classification, persistence, or failure isolation —
 *     removing the logger calls entirely would not change this function's
 *     return value for any input.
 *   progressLogEvery — log a progress line every N organisations processed
 *     (default 500; set 0/Infinity to disable interim progress logging).
 *
 * S-1 (malformed policyThresholdMs) halts the whole sweep before any
 * Organisation is processed. Per-Organisation failures (S-2/S-3, or a
 * generate-trust-profile.js failure) are isolated — recorded, never halting
 * or contaminating any other Organisation's processing in the same sweep
 * (ENG-032 §5).
 */
async function runScheduledSweep({ policyThresholdMs, deps = {} } = {}) {
  if (typeof policyThresholdMs !== 'number' || !Number.isFinite(policyThresholdMs) || policyThresholdMs <= 0) {
    throw new SweepMalformedConfigError('policyThresholdMs must be a positive, finite number');
  }

  const listOrganisationIds = deps.listOrganisationIds || require('../../organisation/resolve').listOrganisationIds;
  const getCurrent = deps.getCurrent || require('../store').getCurrent;
  const generateTrustProfile = deps.generateTrustProfile || require('../generate-trust-profile').generateTrustProfile;
  const save = deps.save || require('../store').save;
  const now = deps.now || (() => new Date().toISOString());
  const logger = deps.logger || require('../../infra/utils/logger');
  const progressLogEvery = Number.isFinite(deps.progressLogEvery) ? deps.progressLogEvery : 500;

  const processed = [];
  const skipped = [];
  const failed = [];
  const sweepStartedAt = Date.now();

  let organisationIds;
  try {
    organisationIds = await listOrganisationIds();
  } catch (cause) {
    throw new SweepMalformedConfigError(`population enumeration failed: ${cause.message}`);
  }

  logger.info(`scheduled sweep starting: ${organisationIds.length} Organisations in population, policyThresholdMs=${policyThresholdMs}`);

  let considered = 0;
  for (const organisationId of organisationIds) {
    considered += 1;

    // S-3: each id from the population capability must be a non-empty string.
    if (!isNonEmptyString(organisationId)) {
      skipped.push({ organisationId, reason: 'malformed organisationId from population enumeration (S-3)' });
      logger.warn(`skipped ${JSON.stringify(organisationId)}: malformed organisationId from population enumeration (S-3)`);
      continue;
    }

    let current;
    try {
      current = await getCurrent(organisationId);
    } catch (cause) {
      skipped.push({ organisationId, reason: `current-resolution read failed (S-2): ${cause.message}` });
      logger.warn(`skipped ${organisationId}: current-resolution read failed (S-2): ${cause.message}`);
      continue;
    }

    // S-2: the read must be either "exists" with a generatedAt, or an honest
    // "none generated yet" — never an ambiguous value standing in for either.
    if (current == null || typeof current.exists !== 'boolean' || (current.exists && !isNonEmptyString(current.generatedAt))) {
      skipped.push({ organisationId, reason: 'malformed current-resolution read (S-2)' });
      logger.warn(`skipped ${organisationId}: malformed current-resolution read (S-2)`);
      continue;
    }

    // Classification (§3 step 3) — "none generated yet" is always stale.
    const nowMs = Date.parse(now());
    const isStale = !current.exists || (nowMs - Date.parse(current.generatedAt)) > policyThresholdMs;
    if (!isStale) continue; // current — no action taken this sweep.

    // Invoke ENG-029's generation function exactly once for this Organisation
    // — never speculatively, never more than once per sweep (§3's own rule).
    const generatedAt = now();
    try {
      const instance = await generateTrustProfile(organisationId, { trigger: 'scheduled', generatedAt });
      await save(instance);
      processed.push({ organisationId, generatedAt });
    } catch (cause) {
      // Isolated per-Organisation — never halts or affects any other
      // Organisation's processing in the same sweep (§5's isolation rule).
      failed.push({ organisationId, reason: cause.message });
      logger.warn(`generation failed for ${organisationId}: ${cause.message}`);
    }

    if (progressLogEvery > 0 && considered % progressLogEvery === 0) {
      const elapsedSec = ((Date.now() - sweepStartedAt) / 1000).toFixed(1);
      logger.info(`sweep progress: ${considered}/${organisationIds.length} considered — ${processed.length} processed, ${skipped.length} skipped, ${failed.length} failed (${elapsedSec}s elapsed)`);
    }
  }

  const totalElapsedSec = ((Date.now() - sweepStartedAt) / 1000).toFixed(1);
  logger.info(`scheduled sweep complete: ${processed.length} processed, ${skipped.length} skipped, ${failed.length} failed, out of ${organisationIds.length} (${totalElapsedSec}s elapsed)`);

  return { processed, skipped, failed };
}

module.exports = { runScheduledSweep, SweepMalformedConfigError };
