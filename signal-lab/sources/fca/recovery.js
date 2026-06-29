'use strict';

// recovery.js — recover an interrupted FCA collection run.
//
// Reference Collector v0.1 — PHASE 7 (IMP-FCA-001 §7; CCS-FCA-001 §10, §12).
//
// Top-level interruption recovery: reads the run's manifest (anchor / scope /
// family — reused, not recomputed), resumes the remaining work (resume.js), and
// updates the manifest with refreshed tallies + a resume-history entry. It
// preserves all existing evidence (additive only) and is idempotent: recovering a
// complete run does nothing [CR-FCA-03/09/14].
//
// Authority: CCS-FCA-001 §10, §12; CCD-FCA-001 CR-FCA-03/09/14; IMP-FCA-001 §7.

const { readManifest, writeManifest } = require('./manifest');
const { inspectRun, planResume, resumeCollection } = require('./resume');

/** True when no scope endpoint needs observing/continuing (every plan item is a skip). */
function isComplete(runDir, family, scope) {
  return planResume(runDir, family, scope).every((p) => p.action.startsWith('skip'));
}

/** Recompute manifest tallies from preserved state (collection metadata only). */
function recomputeTallies(runDir) {
  const state = inspectRun(runDir);
  let endpointsPreserved = 0; let pagesPreserved = 0; let transportErrors = 0;
  for (const endpointId of Object.keys(state)) {
    let anySuccess = false;
    for (const g of Object.values(state[endpointId].groups)) {
      pagesPreserved += g.lineCount;
      if (g.successCount > 0) anySuccess = true;
      transportErrors += (g.lineCount - g.successCount);
    }
    if (anySuccess) endpointsPreserved++;
  }
  return { endpointsPreserved, pagesPreserved, transportErrors, artefacts: Object.keys(state).map((e) => `${e}.ndjson`) };
}

/**
 * Recover (resume) an interrupted run.
 * @param {string} runDir
 * @param {Object} opts - { config, retry, _fetch, _retryHelpers, now }
 * @returns {Promise<{ summary: Object, manifest: Object, alreadyComplete: boolean }>}
 */
async function recoverRun(runDir, opts = {}) {
  const manifest = readManifest(runDir);
  const family = manifest.family || 'firm';
  const anchor = manifest.anchor;
  const scope = manifest.scope || null;
  const now = opts.now ?? (() => new Date().toISOString());

  if (isComplete(runDir, family, scope)) {
    return { summary: { skipped: [], continued: [], observed: [], newPages: 0 }, manifest, alreadyComplete: true };
  }

  const summary = await resumeCollection(runDir, {
    family, anchor, scope, config: opts.config, runId: manifest.runId,
    retry: opts.retry, _fetch: opts._fetch, _retryHelpers: opts._retryHelpers,
  });

  // Update manifest: refreshed tallies + an additive resume-history entry.
  const t = recomputeTallies(runDir);
  manifest.endpointsPreserved = t.endpointsPreserved;
  manifest.pagesPreserved = t.pagesPreserved;
  manifest.transportErrors = t.transportErrors;
  manifest.artefacts = t.artefacts;
  manifest.resumeHistory = manifest.resumeHistory || [];
  manifest.resumeHistory.push({
    at: now(),
    skipped: summary.skipped.length,
    continued: summary.continued.length,
    observed: summary.observed.length,
    newPages: summary.newPages,
  });
  writeManifest(runDir, manifest);

  return { summary, manifest, alreadyComplete: false };
}

module.exports = { recoverRun, isComplete, recomputeTallies };
