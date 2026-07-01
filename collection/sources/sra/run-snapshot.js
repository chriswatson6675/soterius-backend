'use strict';

// run-snapshot.js — orchestrate the constitutional pipeline into a sealed package.
//
// SRA Snapshot Collector v0.1 — orchestration layer.
//
// Composes the ALREADY-IMPLEMENTED modules into one Collection Package. It
// introduces NO collection logic: every stage is a black box whose output is passed
// directly to the next. It adds NO scheduling, NO retries (the Observe layer owns
// retry), and knows NOTHING about Railway/deployment.
//
//   create package → Observe → Preserve(+Manifest) → Extract → Provenance →
//   Integrity(verify) → Seal
//
// Guarantees:
//   - stops immediately on the first stage failure,
//   - NEVER seals a failed collection,
//   - seals ONLY after successful integrity verification,
//   - never deletes or repairs any artefact already written.
//
// Collaborators are injectable (opts.deps) for testing; defaults are the real
// modules. This module never reimplements a collaborator's responsibility.

const { randomUUID } = require('node:crypto');

const pkg = require('./collection-package');
const { acquireSnapshot } = require('./acquire-snapshot');
const { createPreserver } = require('./preserve-snapshot');
const { buildManifest, writeManifest, COLLECTOR_VERSION } = require('./manifest');
const { extractRun } = require('./extract');
const { writeLineage } = require('./provenance');
const { verifyPackage } = require('./integrity');
const { SRA_SNAPSHOT_SOURCE } = require('./snapshot-source');
const { createRun, STATES } = require('./collection-run');

const DEFAULT_DEPS = {
  createPackage: pkg.createPackage,
  seal: pkg.seal,
  acquireSnapshot,
  createPreserver,
  buildManifest,
  writeManifest,
  extractRun,
  writeLineage,
  verifyPackage,
};

/** Record a stage failure on the run + result, and return the result (stops the pipeline). */
function failResult(run, result, stage, err) {
  if (!run.isTerminal()) run.fail(`${stage}: ${err.message}`);
  result.ok = false;
  result.failedStage = stage;
  result.error = `${stage}: ${err.message}`;
  result.state = run.state;
  result.sealed = false;
  result.history = run.history();
  return result;
}

/**
 * Run the complete constitutional pipeline for one snapshot. Never throws on a
 * stage failure — returns a structured execution result. Throws only on missing
 * required inputs (programmer error).
 *
 * @param {Object} opts
 * @param {Object}   opts.config  - SRA client config ({ baseUrl, subscriptionKey })
 * @param {string}   opts.runRoot - directory under which the package is created
 * @param {Object}   [opts.source] - snapshot-source definition
 * @param {string}   [opts.runId]
 * @param {function} [opts.now]
 * @param {Object}   [opts.retry] / [opts._fetch] / [opts._retryHelpers] - passed to Observe
 * @param {Object}   [opts.deps]  - collaborator overrides (tests)
 * @returns {Promise<Object>} execution result
 */
async function collectSnapshot(opts = {}) {
  const { config, runRoot, source = SRA_SNAPSHOT_SOURCE } = opts;
  if (!config) throw new Error('collectSnapshot requires config');
  if (!runRoot) throw new Error('collectSnapshot requires runRoot');

  const deps = { ...DEFAULT_DEPS, ...(opts.deps || {}) };
  const now = opts.now ?? (() => new Date().toISOString());
  const runId = opts.runId ?? (opts._uuid ?? randomUUID)();

  const run = createRun({ runId, now });
  const result = {
    ok: false, runId, dir: null, state: run.state, sealed: false,
    failedStage: null, error: null, productionTimestamp: null,
    stages: {}, integrity: null, history: null,
  };

  // CREATED → create the package directory tree.
  let dir;
  try { dir = deps.createPackage(runRoot, runId); result.dir = dir; }
  catch (e) { return failResult(run, result, 'create-package', e); }

  const startedAt = now();

  // OBSERVE
  let acquire;
  try {
    run.to(STATES.OBSERVING);
    acquire = await deps.acquireSnapshot({ config, source, retry: opts.retry, _fetch: opts._fetch, _retryHelpers: opts._retryHelpers });
  } catch (e) { return failResult(run, result, 'observe', e); }
  if (!acquire || !acquire.ok) {
    const detail = acquire && acquire.error
      ? `transport ${acquire.error.errorType}${acquire.error.httpStatus ? ` (HTTP ${acquire.error.httpStatus})` : ''}`
      : 'acquisition failed';
    return failResult(run, result, 'observe', new Error(detail));
  }
  result.productionTimestamp = acquire.productionTimestamp ?? null;
  result.stages.observe = { segmentCount: acquire.segmentCount, productionTimestamp: acquire.productionTimestamp ?? null };

  // PRESERVE (+ MANIFEST)
  try {
    run.to(STATES.PRESERVING);
    const preserver = deps.createPreserver(dir, { runId, now });
    for (const seg of acquire.segments) {
      preserver.preserveSegment(seg.body, { name: seg.name, requestUri: seg.requestUri, productionTimestamp: acquire.productionTimestamp });
    }
    const tally = preserver.tally();
    const manifest = deps.buildManifest(
      { runId, collectionStartedAt: startedAt, collectionCompletedAt: now(), snapshotProductionTimestamp: acquire.productionTimestamp ?? null },
      tally,
    );
    deps.writeManifest(dir, manifest);
    result.stages.preserve = { segmentsPreserved: tally.segmentCount, totalBytes: tally.totalBytes };
  } catch (e) { return failResult(run, result, 'preserve', e); }

  // EXTRACT
  try {
    run.to(STATES.EXTRACTING);
    const extract = deps.extractRun(dir, { source });
    result.stages.extract = { records: extract.tally.records, byObjectType: extract.tally.byObjectType };
  } catch (e) { return failResult(run, result, 'extract', e); }

  // PROVENANCE
  try {
    run.to(STATES.PROVENANCE);
    const lineage = deps.writeLineage(dir);
    result.stages.provenance = { lineageRecords: lineage.lineageRecords };
  } catch (e) { return failResult(run, result, 'provenance', e); }

  // VERIFY (integrity) — the gate before sealing.
  let integrity;
  try {
    run.to(STATES.VERIFYING);
    integrity = deps.verifyPackage(dir);
    result.integrity = integrity;
  } catch (e) { return failResult(run, result, 'verify', e); }
  if (!integrity.ok) return failResult(run, result, 'verify', new Error('integrity verification failed'));

  // SEAL — write the marker FIRST; advance to SEALED only once it succeeds.
  try {
    deps.seal(dir, {
      runId,
      collectorVersion: COLLECTOR_VERSION,
      payload: {
        integrity: {
          records: integrity.records,
          rawHashes: { checked: integrity.rawHashes.checked, verified: integrity.rawHashes.verified },
        },
      },
    });
  } catch (e) { return failResult(run, result, 'seal', e); }

  run.to(STATES.SEALED);
  result.ok = true;
  result.sealed = true;
  result.state = run.state;
  result.history = run.history();
  return result;
}

module.exports = { collectSnapshot, DEFAULT_DEPS };
