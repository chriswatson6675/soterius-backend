'use strict';

// sra-worker.js — Railway background worker that DRIVES the SRA Collection Layer.
//
// This worker is NOT part of the Collection Layer. It is an operational component
// that polls the SRA source and, when a newer snapshot exists, invokes the already
// completed collector end-to-end. It implements NO collection logic, parses NO
// evidence, and modifies NO Collection Package — it only composes the public entry
// points of the constitutional layer:
//
//   connectivity-check  → is the source reachable + what is its production timestamp?
//   run-snapshot        → collectSnapshot()  (Observe→…→Seal, atomic)
//   report              → writeReports()     (read-only operational reports)
//   snapshot-run-model  → loadRunModel()     (read-only; latest local production ts)
//   collection-package  → listSealed()       (read-only; existing sealed packages)
//
// Operational health is tracked via worker-health.js (operational state only — never
// evidence). Collaborators, logger, sleeper, and health are injectable for testing.

const fs = require('node:fs');
const path = require('node:path');

const sraClient = require('../sources/sra/sra-client');
const { checkConnectivity } = require('../sources/sra/connectivity-check');
const { collectSnapshot } = require('../sources/sra/run-snapshot');
const { writeReports } = require('../sources/sra/report');
const { loadRunModel } = require('../sources/sra/snapshot-run-model');
const { listSealed } = require('../sources/sra/collection-package');
const { SRA_SNAPSHOT_SOURCE } = require('../sources/sra/snapshot-source');
const { createHealth, STATUS } = require('./worker-health');

// ── logging ────────────────────────────────────────────────────────────────────
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function makeLogger(level = 'info', sink = (line) => process.stdout.write(line + '\n')) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, extra) => {
    if ((LEVELS[lvl] ?? 2) <= threshold) sink(JSON.stringify({ at: new Date().toISOString(), level: lvl, worker: 'sra-worker', msg, ...(extra || {}) }));
  };
  return {
    error: (m, e) => emit('error', m, e),
    warn: (m, e) => emit('warn', m, e),
    info: (m, e) => emit('info', m, e),
    debug: (m, e) => emit('debug', m, e),
  };
}

// ── configuration ────────────────────────────────────────────────────────────────

/** Load worker configuration from the environment. */
function loadConfig(env = process.env) {
  const seconds = env.CHECK_INTERVAL ? parseInt(env.CHECK_INTERVAL, 10) : 3600; // default 1h
  return {
    client: sraClient.loadConfig(env),       // { subscriptionKey, baseUrl }
    runRoot: env.RUN_ROOT ?? null,
    checkIntervalMs: seconds * 1000,
    logLevel: env.LOG_LEVEL ?? 'info',
    healthPort: env.HEALTH_PORT ? parseInt(env.HEALTH_PORT, 10) : null,
    source: SRA_SNAPSHOT_SOURCE,
  };
}

/** Validate worker configuration. */
function validateConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['configuration object missing'] };
  errors.push(...sraClient.validateConfig(cfg.client).errors);
  if (!cfg.runRoot) errors.push('RUN_ROOT is not set');
  if (!Number.isFinite(cfg.checkIntervalMs) || cfg.checkIntervalMs <= 0) errors.push('CHECK_INTERVAL is invalid');
  return { ok: errors.length === 0, errors };
}

// ── cancellable sleep ──────────────────────────────────────────────────────────────
function defaultMakeSleeper(ms) {
  let timer; let resolve;
  const promise = new Promise((r) => { resolve = r; timer = setTimeout(r, ms); });
  return { promise, cancel() { clearTimeout(timer); resolve(); } };
}

// A no-op health sink so createWorker works without an injected health tracker.
const NULL_HEALTH = {
  setStatus() {}, markCheck() {}, markSkipped() {}, markCollected() {}, markError() {}, afterCycle() {},
};

// ── the worker ─────────────────────────────────────────────────────────────────────

/**
 * Create a worker bound to a validated config.
 * @param {Object} opts - { config, logger, deps, makeSleeper, health }
 */
function createWorker(opts = {}) {
  const config = opts.config;
  if (!config) throw new Error('createWorker requires a config');
  const logger = opts.logger || makeLogger(config.logLevel);
  const makeSleeper = opts.makeSleeper || defaultMakeSleeper;
  const health = opts.health || NULL_HEALTH;
  const deps = {
    checkConnectivity, collectSnapshot, writeReports, loadRunModel, listSealed,
    ...(opts.deps || {}),
  };

  let stopping = false;
  let sleeper = null;

  /** Newest production timestamp among locally SEALED packages (read-only), or null. */
  function latestLocalProductionTimestamp() {
    let latest = null;
    for (const p of deps.listSealed(config.runRoot)) {
      let model;
      try { model = deps.loadRunModel(p.dir); } catch { continue; }
      const ts = model.manifest && model.manifest.snapshotProductionTimestamp;
      if (ts && (latest === null || ts > latest)) latest = ts;
    }
    return latest;
  }

  /** Run a single poll cycle. Never throws; returns a structured cycle outcome. */
  async function runCycle() {
    health.setStatus(STATUS.CHECKING);
    health.markCheck();

    const conn = await deps.checkConnectivity({ config: config.client, source: config.source });
    if (!conn.ok) {
      logger.warn('connectivity check failed', { detail: conn.detail, httpStatus: conn.httpStatus });
      health.markSkipped('connectivity');
      return { action: 'skip', reason: 'connectivity', conn };
    }

    const liveTs = conn.productionTimestamp ?? null;
    const localTs = latestLocalProductionTimestamp();
    const newer = localTs === null ? true : (liveTs !== null && liveTs > localTs);
    if (!newer) {
      logger.info('no newer snapshot; nothing to collect', { liveTs, localTs });
      health.markSkipped('up-to-date');
      return { action: 'skip', reason: 'up-to-date', liveTs, localTs };
    }

    logger.info('newer snapshot available; collecting', { liveTs, localTs });
    health.setStatus(STATUS.COLLECTING);
    const result = await deps.collectSnapshot({ config: config.client, runRoot: config.runRoot, source: config.source });

    if (!result.ok || !result.sealed) {
      logger.error('collection failed; package left unsealed', { runId: result.runId, failedStage: result.failedStage, error: result.error });
      health.markError(result.error || `collection failed at ${result.failedStage}`);
      return { action: 'collected', ok: false, result };
    }

    try { deps.writeReports(result.dir); }
    catch (e) { logger.warn('report generation failed', { runId: result.runId, error: e.message }); }

    logger.info('collection sealed', {
      runId: result.runId, dir: result.dir,
      productionTimestamp: result.productionTimestamp,
      records: result.stages && result.stages.extract ? result.stages.extract.records : null,
    });
    health.markCollected(result.runId, result.productionTimestamp);
    return { action: 'collected', ok: true, result };
  }

  /** Run the continuous poll loop until stopped. Resolves when the loop exits cleanly. */
  async function start() {
    logger.info('sra-worker started', { runRoot: config.runRoot, checkIntervalMs: config.checkIntervalMs, logLevel: config.logLevel });
    health.setStatus(STATUS.IDLE);
    while (!stopping) {
      try { await runCycle(); }
      catch (e) { logger.error('cycle error', { error: e.message }); health.markError(e.message); }
      health.afterCycle();
      if (stopping) break;                 // shutdown requested mid-cycle → exit after finishing it
      health.setStatus(STATUS.SLEEPING);
      sleeper = makeSleeper(config.checkIntervalMs);
      await sleeper.promise;               // interruptible: stop() cancels this
      sleeper = null;
    }
    health.setStatus(STATUS.STOPPED);
    logger.info('sra-worker stopped cleanly');
    return { stopped: true };
  }

  /** Request graceful shutdown: finish the current cycle, wake any sleep, then exit. */
  function stop(reason) {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown requested', { reason: reason ?? null });
    if (sleeper) sleeper.cancel();
  }

  return { start, stop, runCycle, isStopping: () => stopping };
}

module.exports = { createWorker, loadConfig, validateConfig, makeLogger, LEVELS };

// ── bootstrap (only when run directly) ───────────────────────────────────────────
if (require.main === module) {
  const config = loadConfig();
  const logger = makeLogger(config.logLevel);
  const v = validateConfig(config);
  if (!v.ok) { logger.error('invalid configuration', { errors: v.errors }); process.exit(2); }

  // Ensure the (mounted-volume) run root exists before polling / health writes.
  try { fs.mkdirSync(config.runRoot, { recursive: true }); }
  catch (e) { logger.error('cannot create RUN_ROOT', { runRoot: config.runRoot, error: e.message }); process.exit(2); }

  const health = createHealth({ statusFile: path.join(config.runRoot, 'worker-status.json') });
  if (config.healthPort) { health.serve(config.healthPort); logger.info('health endpoint listening', { port: config.healthPort }); }

  const worker = createWorker({ config, logger, health });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => worker.stop(sig));
  worker.start()
    .then(() => process.exit(0))
    .catch((e) => { logger.error('fatal worker error', { error: e.message }); process.exit(1); });
}
