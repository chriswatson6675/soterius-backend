'use strict';

// sra-worker.test.js — operational worker tests (no network, no real timers/signals).
//
// Covers config validation, the poll decision (no-new vs newer), successful and
// failed collection driving, connectivity-gated skip, the continuous loop with
// repeated polling, and graceful shutdown (finish current cycle, exit cleanly).
//
// All Collection-Layer collaborators are injected; the worker is exercised as the
// pure orchestrator it is.

const { test } = require('node:test');
const assert = require('node:assert');
const { createWorker, loadConfig, validateConfig } = require('./sra-worker');

function captureLogger() {
  const lines = [];
  const push = (level) => (msg, extra) => lines.push({ level, msg, ...(extra || {}) });
  return { lines, error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug') };
}

const CONFIG = { client: { baseUrl: 'https://x', subscriptionKey: 'KEY' }, runRoot: '/runs', checkIntervalMs: 1000, logLevel: 'debug', source: { sourceId: 'sra' } };
const immediateSleeper = () => ({ promise: Promise.resolve(), cancel() {} });

// Default dep set for a single cycle; override per test.
function deps(over = {}) {
  return {
    checkConnectivity: async () => ({ ok: true, productionTimestamp: '2026-06-29', httpStatus: 200, detail: 'ok' }),
    listSealed: () => [],
    loadRunModel: () => ({ manifest: {} }),
    collectSnapshot: async () => ({ ok: true, sealed: true, runId: 'SNAP-NEW', dir: '/runs/SNAP-NEW', productionTimestamp: '2026-06-29', stages: { extract: { records: 9 } } }),
    writeReports: () => {},
    ...over,
  };
}

// ── configuration ────────────────────────────────────────────────────────────────

test('loadConfig reads env (interval in seconds → ms) and validateConfig checks it', () => {
  const cfg = loadConfig({ SRA_SUBSCRIPTION_KEY: 'K', SRA_BASE_URL: 'https://x', RUN_ROOT: '/r', CHECK_INTERVAL: '300', LOG_LEVEL: 'warn' });
  assert.strictEqual(cfg.runRoot, '/r');
  assert.strictEqual(cfg.checkIntervalMs, 300000);
  assert.strictEqual(cfg.logLevel, 'warn');
  assert.deepStrictEqual(validateConfig(cfg), { ok: true, errors: [] });

  assert.ok(validateConfig(loadConfig({ SRA_BASE_URL: 'https://x', RUN_ROOT: '/r' })).errors.some((e) => /SRA_SUBSCRIPTION_KEY/.test(e)));
  assert.ok(validateConfig(loadConfig({ SRA_SUBSCRIPTION_KEY: 'K' })).errors.some((e) => /RUN_ROOT/.test(e)));
});

// ── decision logic ───────────────────────────────────────────────────────────────

test('no new snapshot: local production timestamp equals live → skip, no collection', async () => {
  let collected = false;
  const w = createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    checkConnectivity: async () => ({ ok: true, productionTimestamp: '2026-06-28' }),
    listSealed: () => [{ runId: 'OLD', dir: '/runs/OLD', sealed: true }],
    loadRunModel: () => ({ manifest: { snapshotProductionTimestamp: '2026-06-28' } }),
    collectSnapshot: async () => { collected = true; return { ok: true, sealed: true }; },
  }) });

  const out = await w.runCycle();
  assert.strictEqual(out.action, 'skip');
  assert.strictEqual(out.reason, 'up-to-date');
  assert.strictEqual(collected, false, 'collectSnapshot must NOT run when up to date');
});

test('new snapshot available + successful collection: collects and writes reports', async () => {
  const calls = { collect: 0, report: 0 };
  const logger = captureLogger();
  const w = createWorker({ config: CONFIG, logger, deps: deps({
    checkConnectivity: async () => ({ ok: true, productionTimestamp: '2026-06-29' }),
    listSealed: () => [{ runId: 'OLD', dir: '/runs/OLD', sealed: true }],
    loadRunModel: () => ({ manifest: { snapshotProductionTimestamp: '2026-06-28' } }),
    collectSnapshot: async () => { calls.collect++; return { ok: true, sealed: true, runId: 'SNAP-NEW', dir: '/runs/SNAP-NEW', productionTimestamp: '2026-06-29', stages: { extract: { records: 9 } } }; },
    writeReports: () => { calls.report++; },
  }) });

  const out = await w.runCycle();
  assert.strictEqual(out.action, 'collected');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls.collect, 1);
  assert.strictEqual(calls.report, 1);
  assert.ok(logger.lines.some((l) => l.msg === 'collection sealed' && l.runId === 'SNAP-NEW'));
});

test('first run (no local sealed package) always collects', async () => {
  let collected = false;
  const w = createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    listSealed: () => [],
    collectSnapshot: async () => { collected = true; return { ok: true, sealed: true, runId: 'SNAP-1', dir: '/runs/SNAP-1', stages: {} }; },
  }) });
  await w.runCycle();
  assert.strictEqual(collected, true);
});

test('failed collection: logged, no reports written, worker does not throw', async () => {
  const calls = { report: 0 };
  const logger = captureLogger();
  const w = createWorker({ config: CONFIG, logger, deps: deps({
    listSealed: () => [],
    collectSnapshot: async () => ({ ok: false, sealed: false, runId: 'SNAP-X', failedStage: 'verify', error: 'verify: integrity verification failed' }),
    writeReports: () => { calls.report++; },
  }) });

  const out = await w.runCycle();
  assert.strictEqual(out.action, 'collected');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(calls.report, 0, 'no reports for an unsealed/failed collection');
  assert.ok(logger.lines.some((l) => l.level === 'error' && l.msg === 'collection failed; package left unsealed'));
});

test('connectivity failure: skip cycle, no collection attempted', async () => {
  let collected = false;
  const w = createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    checkConnectivity: async () => ({ ok: false, detail: 'transport CONNECTION_ERROR', httpStatus: null }),
    collectSnapshot: async () => { collected = true; return { ok: true, sealed: true }; },
  }) });
  const out = await w.runCycle();
  assert.strictEqual(out.action, 'skip');
  assert.strictEqual(out.reason, 'connectivity');
  assert.strictEqual(collected, false);
});

// ── loop + shutdown ────────────────────────────────────────────────────────────────

test('repeated polling: the loop runs multiple cycles until stopped', async () => {
  let cycles = 0;
  const w = createWorker({ config: CONFIG, logger: captureLogger(), makeSleeper: immediateSleeper, deps: deps({
    checkConnectivity: async () => {
      cycles++;
      if (cycles >= 3) w.stop('test-limit');
      return { ok: true, productionTimestamp: '2026-06-28' }; // up-to-date → skip each cycle
    },
    listSealed: () => [{ runId: 'OLD', dir: '/runs/OLD', sealed: true }],
    loadRunModel: () => ({ manifest: { snapshotProductionTimestamp: '2026-06-28' } }),
  }) });

  const res = await w.start();
  assert.strictEqual(res.stopped, true);
  assert.strictEqual(cycles, 3, 'polled exactly until stop was requested');
});

test('graceful shutdown: stop() mid-cycle finishes the current collection then exits cleanly', async () => {
  const calls = { collect: 0, report: 0 };
  const logger = captureLogger();
  const w = createWorker({ config: CONFIG, logger, makeSleeper: immediateSleeper, deps: deps({
    listSealed: () => [],
    collectSnapshot: async () => {
      calls.collect++;
      w.stop('SIGTERM');                       // shutdown arrives DURING the collection
      return { ok: true, sealed: true, runId: 'SNAP-1', dir: '/runs/SNAP-1', stages: { extract: { records: 1 } } };
    },
    writeReports: () => { calls.report++; },
  }) });

  const res = await w.start();
  assert.strictEqual(res.stopped, true);
  assert.strictEqual(calls.collect, 1, 'the in-flight collection completed (never interrupted → never partially sealed)');
  assert.strictEqual(calls.report, 1, 'reports for the completed collection were still written');
  assert.ok(logger.lines.some((l) => l.msg === 'shutdown requested' && l.reason === 'SIGTERM'));
  assert.ok(logger.lines.some((l) => l.msg === 'sra-worker stopped cleanly'));
});

test('stop() before start() makes the loop exit immediately without a cycle', async () => {
  let cycles = 0;
  const w = createWorker({ config: CONFIG, logger: captureLogger(), makeSleeper: immediateSleeper, deps: deps({
    checkConnectivity: async () => { cycles++; return { ok: true, productionTimestamp: '2026-06-28' }; },
  }) });
  w.stop('pre-start');
  await w.start();
  assert.strictEqual(cycles, 0);
});
