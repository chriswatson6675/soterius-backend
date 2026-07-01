'use strict';

// sra-worker.js — Railway background worker that DRIVES the SRA Collection Layer.
//
// This worker is NOT part of the Collection Layer. It is an operational component
// that polls the SRA source and, when the source snapshot has CHANGED, invokes the
// already completed collector end-to-end. It implements NO collection logic, parses
// NO evidence, and modifies NO Collection Package — it only composes the public
// entry points of the constitutional layer:
//
//   connectivity-check  → is the source reachable + authenticated?
//   acquire-snapshot    → acquire the current snapshot (to determine its content hash)
//   run-snapshot        → collectSnapshot()  (Observe→…→Seal, atomic; UNCHANGED)
//   report              → writeReports()     (read-only operational reports)
//   snapshot-run-model  → loadRunModel()     (read-only; latest package's recorded raw hash)
//   collection-package  → listSealed() / readSeal()  (read-only; existing sealed packages)
//
// Duplicate detection (TD-1) is CONTENT-HASH based, not timestamp based: the SRA
// source exposes no production timestamp, so the worker compares the SHA-256 of the
// freshly-acquired snapshot against the SHA-256 already recorded in the latest sealed
// Collection Package's raw index (reused, never recomputed from the raw file). The
// dedup logic is source-agnostic. Operational health is tracked via worker-health.js
// (operational state only — never evidence). Collaborators, logger, sleeper, and
// health are injectable for testing.

const fs = require('node:fs');
const path = require('node:path');

const sraClient = require('../../collection/sources/sra/sra-client');
const { checkConnectivity } = require('../../collection/sources/sra/connectivity-check');
const { acquireSnapshot } = require('../../collection/sources/sra/acquire-snapshot');
const { collectSnapshot } = require('../../collection/sources/sra/run-snapshot');
const { writeReports } = require('../../collection/sources/sra/report');
const { loadRunModel } = require('../../collection/sources/sra/snapshot-run-model');
const { listSealed, readSeal } = require('../../collection/sources/sra/collection-package');
const { sha256 } = require('../../collection/sources/sra/preserve-snapshot');
const { SRA_SNAPSHOT_SOURCE } = require('../../collection/sources/sra/snapshot-source');
const { createHealth, STATUS } = require('./worker-health');

/** Short hash for logs (operational only). */
function shortHash(h) { return h ? String(h).slice(0, 12) : null; }

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
    checkConnectivity, acquireSnapshot, collectSnapshot, writeReports, loadRunModel, listSealed, readSeal,
    transportGet: sraClient.get, // low-level transport, used only for failure diagnostics
    ...(opts.deps || {}),
  };

  let stopping = false;
  let sleeper = null;

  // ── content-hash de-duplication (TD-1) ──────────────────────────────────────────
  // A snapshot fingerprint = the SHA-256(s) of the raw snapshot segment(s), combined.
  // The SAME sha256 the Collection Package uses is applied on both sides — live side
  // hashes the freshly-acquired raw bytes exactly as Preserve does; stored side REUSES
  // the sha256 already recorded in the package raw index (never recomputed from disk).
  function combineHashes(hashes) {
    if (!hashes || hashes.length === 0) return null;
    if (hashes.length === 1) return hashes[0];
    return sha256(Buffer.from(hashes.join('\n'), 'utf8'));
  }

  /** Fingerprint freshly-acquired snapshot segments (live side). */
  function fingerprintSegments(segments) {
    return combineHashes((segments || []).map((s) => sha256(Buffer.from(String(s.body ?? ''), 'utf8'))));
  }

  /** Fingerprint of the latest SEALED package from its RECORDED raw hashes; null if none/unreadable. */
  function latestSealedFingerprint() {
    const sealed = deps.listSealed(config.runRoot);
    if (!sealed.length) return null;
    // Pick the most recently sealed package (by SEALED.sealedAt; listing order as fallback).
    let latest = null;
    for (const p of sealed) {
      let at = '';
      try { const s = deps.readSeal(p.dir); at = (s && s.sealedAt) ? s.sealedAt : ''; } catch { at = ''; }
      if (latest === null || at > latest.at) latest = { dir: p.dir, at };
    }
    let model;
    try { model = deps.loadRunModel(latest.dir); } catch { return null; } // corrupted previous package → no comparable prior
    const hashes = (model.rawIndex || []).map((r) => r && r.sha256).filter(Boolean);
    return combineHashes(hashes); // null if the raw index is missing/empty (corrupted)
  }

  // ── connection diagnostics (TD — operational visibility only) ───────────────────
  // checkConnectivity reports `errorType: 'CONNECTION_ERROR'` but not the underlying
  // Node transport cause. On a connection error the worker runs ONE low-level probe
  // (the same transport the collector uses) purely to surface the root cause
  // (ENOTFOUND / ECONNRESET / ECONNREFUSED / ETIMEDOUT / TLS/cert message, …) and the
  // host being dialled. Diagnostic only — it changes no collection behaviour, decision,
  // or retry; it runs only on the failure path that already skips the cycle.
  async function diagnoseConnection() {
    let host = null; let url = null;
    try { url = sraClient.buildUrl(config.client.baseUrl, config.source && config.source.datasetPath); host = new URL(url).host; } catch { /* ignore */ }
    let r;
    try { r = await deps.transportGet(url, { subscriptionKey: config.client.subscriptionKey }); }
    catch (e) { return { host, probeErrorType: 'PROBE_THREW', underlyingError: e && e.message ? e.message : String(e) }; }
    return { host, probeErrorType: r.errorType, probeHttpStatus: r.httpStatus, underlyingError: r.errorMessage };
  }

  /** Run a single poll cycle. Never throws; returns a structured cycle outcome. */
  async function runCycle() {
    health.setStatus(STATUS.CHECKING);
    health.markCheck();

    // Pre-flight: source reachable + authenticated.
    const conn = await deps.checkConnectivity({ config: config.client, source: config.source });
    if (!conn.ok) {
      const extra = { detail: conn.detail, httpStatus: conn.httpStatus, errorType: conn.errorType ?? null };
      // Expose the root transport cause for a connection error (diagnostics only).
      if (conn.errorType === 'CONNECTION_ERROR') {
        const diag = await diagnoseConnection();
        extra.host = diag.host;
        extra.underlyingError = diag.underlyingError; // e.g. ENOTFOUND / ECONNRESET / ECONNREFUSED / ETIMEDOUT / cert message
        if (diag.probeErrorType && diag.probeErrorType !== 'CONNECTION_ERROR') extra.probeErrorType = diag.probeErrorType;
      }
      logger.warn('connectivity check failed', extra);
      health.markSkipped('connectivity');
      return { action: 'skip', reason: 'connectivity', conn };
    }

    // Acquire the current snapshot (in memory) to determine its content hash.
    const acq = await deps.acquireSnapshot({ config: config.client, source: config.source });
    if (!acq || !acq.ok) {
      logger.warn('snapshot acquisition failed', { error: acq && acq.error ? acq.error : 'no result' });
      health.markSkipped('acquire');
      return { action: 'skip', reason: 'acquire', acq };
    }

    // Content-hash de-duplication (TD-1): compare the live snapshot hash with the hash
    // recorded in the latest sealed Collection Package (reused, never recomputed).
    const liveHash = fingerprintSegments(acq.segments);
    const priorHash = latestSealedFingerprint();
    if (priorHash !== null && liveHash !== null && liveHash === priorHash) {
      logger.info('no new snapshot; content hash unchanged', { hash: shortHash(liveHash) });
      health.markSkipped('unchanged');
      return { action: 'skip', reason: 'unchanged', hash: liveHash };
    }

    // Changed (or no comparable prior): invoke the UNCHANGED Collection Layer, reusing
    // the already-acquired snapshot so it is not downloaded again.
    logger.info('snapshot changed; collecting', { priorHash: shortHash(priorHash), liveHash: shortHash(liveHash) });
    health.setStatus(STATUS.COLLECTING);
    const result = await deps.collectSnapshot({
      config: config.client, runRoot: config.runRoot, source: config.source,
      deps: { acquireSnapshot: async () => acq },
    });

    if (!result.ok || !result.sealed) {
      logger.error('collection failed; package left unsealed', { runId: result.runId, failedStage: result.failedStage, error: result.error });
      health.markError(result.error || `collection failed at ${result.failedStage}`);
      return { action: 'collected', ok: false, result };
    }

    try { deps.writeReports(result.dir); }
    catch (e) { logger.warn('report generation failed', { runId: result.runId, error: e.message }); }

    logger.info('collection sealed', {
      runId: result.runId, dir: result.dir, contentHash: shortHash(liveHash),
      records: result.stages && result.stages.extract ? result.stages.extract.records : null,
    });
    health.markCollected(result.runId, result.productionTimestamp);
    return { action: 'collected', ok: true, result, hash: liveHash };
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
