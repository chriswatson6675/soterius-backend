'use strict';

// On-Demand Generation Trigger — ENG-014 WP-6. No new constitutional
// specification (per the founder's explicit instruction): this composes
// ENG-007's existing on-demand pipeline and ENG-029's generation function
// exactly as ENG-032's already-approved sibling pattern (the Scheduled
// Trigger) already demonstrates, with a single change — what fires it is
// one settled pipeline result, not a population sweep.
//
// TI-P-6: generateTrustProfile is invoked only AFTER runOnDemandObservation
// has already resolved (settled) — never as a step inside it, never
// interleaved with its own orchestration. This module's own sequencing
// (await pipeline, then await generation) makes that ordering structural,
// not just a stated intention.

class OnDemandTriggerError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'OnDemandTriggerError';
    this.cause = cause;
  }
}

/**
 * runOnDemandRegeneration(domain, deps) → Promise<TrustProfileInstance>
 *
 * deps: runOnDemandObservation, generateTrustProfile, save, now,
 *       observationDeps (forwarded, unmodified, to runOnDemandObservation).
 *
 * Throws OnDemandTriggerError if the on-demand pipeline itself did not
 * settle successfully (nothing to generate a Trust Profile from), or
 * propagates generate-trust-profile.js's own construction failure.
 */
async function runOnDemandRegeneration(domain, deps = {}) {
  const runOnDemandObservation = deps.runOnDemandObservation || require('../../observatory/on-demand/on-demand-observation').runOnDemandObservation;
  const generateTrustProfile = deps.generateTrustProfile || require('../generate-trust-profile').generateTrustProfile;
  const save = deps.save || require('../store').save;
  const now = deps.now || (() => new Date().toISOString());

  // Step 1 — the on-demand pipeline runs to completion first, entirely on
  // its own terms (ENG-007). This module does not observe anything itself.
  const observation = await runOnDemandObservation(domain, deps.observationDeps || {});
  if (!observation.ok) {
    throw new OnDemandTriggerError(`on-demand observation did not settle for ${domain}: ${observation.error || 'unknown error'}`);
  }

  // Step 2 — only now, after settlement, is generation invoked — a
  // separate, later act, never a step inside the pipeline above (TI-P-6).
  const instance = await generateTrustProfile(observation.organisationId, {
    trigger: 'on-demand',
    generatedAt: now(),
  });

  await save(instance);
  return instance;
}

module.exports = { runOnDemandRegeneration, OnDemandTriggerError };
