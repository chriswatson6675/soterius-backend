'use strict';

// sra-worker.test.js — operational worker tests (no network, no real timers/signals).
//
// Covers config validation, the CONTENT-HASH poll decision (first / unchanged /
// changed / corrupted-prior), connectivity + acquire gating, the continuous loop
// with repeated polling, and graceful shutdown. All Collection-Layer collaborators
// are injected; the worker is exercised as the pure orchestrator it is.

const { test } = require('node:test');
const assert = require('node:assert');
const { createWorker, loadConfig, validateConfig } = require('./sra-worker');
const { sha256 } = require('../sources/sra/preserve-snapshot');

function captureLogger() {
  const lines = [];
  const push = (level) => (msg, extra) => lines.push({ level, msg, ...(extra || {}) });
  return { lines, error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug') };
}

const CONFIG = { client: { baseUrl: 'https://x', subscriptionKey: 'KEY' }, runRoot: '/runs', checkIntervalMs: 1000, logLevel: 'debug', source: { sourceId: 'sra' } };
const immediateSleeper = () => ({ promise: Promise.resolve(), cancel() {} });

const BODY = '{"Count":1,"Organisations":[{"SraNumber":1,"PracticeName":"A"}]}';
const BODY_HASH = sha256(Buffer.from(BODY, 'utf8')); // single-segment fingerprint

const acqOf = (body) => async () => ({ ok: true, segments: [{ name: 'snapshot.json', body }], productionTimestamp: null });
// Deps fragment for one prior sealed package whose raw index records hash `h`.
function priorSealed(h) {
  return {
    listSealed: () => [{ runId: 'PRIOR', dir: '/runs/PRIOR', sealed: true }],
    readSeal: () => ({ sealedAt: '2026-06-29T00:00:00Z' }),
    loadRunModel: () => ({ rawIndex: [{ sha256: h }] }),
  };
}
function deps(over = {}) {
  return {
    checkConnectivity: async () => ({ ok: true }),
    acquireSnapshot: acqOf(BODY),
    listSealed: () => [],
    readSeal: () => null,
    loadRunModel: () => ({ rawIndex: [] }),
    collectSnapshot: async () => ({ ok: true, sealed: true, runId: 'NEW', dir: '/runs/NEW', stages: { extract: { records: 9 } } }),
    writeReports: () => {},
    ...over,
  };
}

// ── configuration ────────────────────────────────────────────────────────────────

test('loadConfig reads env (interval seconds → ms) and validateConfig checks it', () => {
  const cfg = loadConfig({ SRA_SUBSCRIPTION_KEY: 'K', SRA_BASE_URL: 'https://x', RUN_ROOT: '/r', CHECK_INTERVAL: '300', LOG_LEVEL: 'warn' });
  assert.strictEqual(cfg.runRoot, '/r');
  assert.strictEqual(cfg.checkIntervalMs, 300000);
  assert.deepStrictEqual(validateConfig(cfg), { ok: true, errors: [] });
  assert.ok(validateConfig(loadConfig({ SRA_BASE_URL: 'https://x', RUN_ROOT: '/r' })).errors.some((e) => /SRA_SUBSCRIPTION_KEY/.test(e)));
  assert.ok(validateConfig(loadConfig({ SRA_SUBSCRIPTION_KEY: 'K' })).errors.some((e) => /RUN_ROOT/.test(e)));
});

// ── content-hash decision ──────────────────────────────────────────────────────────

test('first collection: no prior sealed package → collects', async () => {
  const calls = { collect: 0, report: 0 };
  const w = createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    listSealed: () => [],
    collectSnapshot: async () => { calls.collect++; return { ok: true, sealed: true, runId: 'NEW', dir: '/runs/NEW', stages: { extract: { records: 9 } } }; },
    writeReports: () => { calls.report++; },
  }) });
  const out = await w.runCycle();
  assert.strictEqual(out.action, 'collected');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls.collect, 1);
  assert.strictEqual(calls.report, 1);
});

test('unchanged snapshot: live hash equals the prior package hash → skip, NO collection', async () => {
  let collected = false;
  const logger = captureLogger();
  const w = createWorker({ config: CONFIG, logger, deps: deps({
    acquireSnapshot: acqOf(BODY),
    ...priorSealed(BODY_HASH), // prior package recorded the SAME content hash
    collectSnapshot: async () => { collected = true; return { ok: true, sealed: true }; },
  }) });
  const out = await w.runCycle();
  assert.strictEqual(out.action, 'skip');
  assert.strictEqual(out.reason, 'unchanged');
  assert.strictEqual(collected, false, 'identical snapshot must NOT produce a duplicate package');
  assert.ok(logger.lines.some((l) => l.msg === 'no new snapshot; content hash unchanged'));
});

test('changed snapshot: live hash differs from the prior package hash → collects', async () => {
  let collected = false;
  const w = createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    acquireSnapshot: acqOf(BODY),
    ...priorSealed('a-different-hash-000000'),
    collectSnapshot: async () => { collected = true; return { ok: true, sealed: true, runId: 'NEW', dir: '/runs/NEW', stages: {} }; },
  }) });
  const out = await w.runCycle();
  assert.strictEqual(out.action, 'collected');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(collected, true);
});

test('corrupted previous package: unreadable model OR empty raw index → collects (safe)', async () => {
  // (a) loadRunModel throws
  let c1 = false;
  await createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    listSealed: () => [{ runId: 'P', dir: '/runs/P', sealed: true }],
    readSeal: () => ({ sealedAt: 'x' }),
    loadRunModel: () => { throw new Error('corrupt'); },
    collectSnapshot: async () => { c1 = true; return { ok: true, sealed: true, stages: {} }; },
  }) }).runCycle();
  assert.strictEqual(c1, true);

  // (b) raw index present but empty (no recorded hash)
  let c2 = false;
  await createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    listSealed: () => [{ runId: 'P', dir: '/runs/P', sealed: true }],
    readSeal: () => ({ sealedAt: 'x' }),
    loadRunModel: () => ({ rawIndex: [] }),
    collectSnapshot: async () => { c2 = true; return { ok: true, sealed: true, stages: {} }; },
  }) }).runCycle();
  assert.strictEqual(c2, true);
});

test('the already-acquired snapshot is reused by collectSnapshot (no re-download)', async () => {
  let injected = null;
  const acq = { ok: true, segments: [{ name: 'snapshot.json', body: BODY }], productionTimestamp: null };
  const w = createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    acquireSnapshot: async () => acq,
    listSealed: () => [],
    collectSnapshot: async (args) => { injected = args.deps && args.deps.acquireSnapshot; return { ok: true, sealed: true, stages: {} }; },
  }) });
  await w.runCycle();
  assert.strictEqual(typeof injected, 'function', 'collectSnapshot receives an injected acquireSnapshot');
  assert.strictEqual(await injected(), acq, 'the injected acquire returns the worker-acquired snapshot (not re-fetched)');
});

test('connectivity failure: skip; neither acquire nor collect attempted', async () => {
  let acquired = false; let collected = false;
  const out = await createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    checkConnectivity: async () => ({ ok: false, detail: 'transport CONNECTION_ERROR' }),
    acquireSnapshot: async () => { acquired = true; return { ok: true, segments: [] }; },
    collectSnapshot: async () => { collected = true; return { ok: true, sealed: true }; },
  }) }).runCycle();
  assert.strictEqual(out.reason, 'connectivity');
  assert.strictEqual(acquired, false);
  assert.strictEqual(collected, false);
});

test('CONNECTION_ERROR diagnostics: logs the underlying transport cause + host (no behaviour change)', async () => {
  let probed = 0; let acquired = false; let collected = false;
  const logger = captureLogger();
  const out = await createWorker({ config: CONFIG, logger, deps: deps({
    checkConnectivity: async () => ({ ok: false, errorType: 'CONNECTION_ERROR', detail: 'transport CONNECTION_ERROR', httpStatus: null }),
    transportGet: async () => { probed++; return { errorType: 'CONNECTION_ERROR', httpStatus: null, errorMessage: 'ENOTFOUND' }; },
    acquireSnapshot: async () => { acquired = true; return { ok: true, segments: [] }; },
    collectSnapshot: async () => { collected = true; return { ok: true, sealed: true }; },
  }) }).runCycle();

  assert.strictEqual(out.action, 'skip');
  assert.strictEqual(out.reason, 'connectivity'); // behaviour unchanged
  assert.strictEqual(acquired, false);
  assert.strictEqual(collected, false);
  assert.strictEqual(probed, 1, 'a single diagnostic probe runs on CONNECTION_ERROR');

  const warn = logger.lines.find((l) => l.msg === 'connectivity check failed');
  assert.strictEqual(warn.errorType, 'CONNECTION_ERROR');
  assert.strictEqual(warn.underlyingError, 'ENOTFOUND', 'the root transport code is surfaced');
  assert.ok('host' in warn, 'the dialled host is surfaced');
  assert.strictEqual(warn.detail, 'transport CONNECTION_ERROR', 'the existing summary is retained');
});

test('non-connection connectivity failure: no diagnostic probe (e.g. auth/shape)', async () => {
  let probed = 0;
  await createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    checkConnectivity: async () => ({ ok: false, errorType: 'HTTP_ERROR', detail: 'records not found', httpStatus: 200 }),
    transportGet: async () => { probed++; return {}; },
  }) }).runCycle();
  assert.strictEqual(probed, 0, 'probe runs only for CONNECTION_ERROR');
});

test('acquire failure: skip; no collection', async () => {
  let collected = false;
  const out = await createWorker({ config: CONFIG, logger: captureLogger(), deps: deps({
    acquireSnapshot: async () => ({ ok: false, error: { errorType: 'HTTP_ERROR', httpStatus: 500 } }),
    collectSnapshot: async () => { collected = true; return { ok: true, sealed: true }; },
  }) }).runCycle();
  assert.strictEqual(out.reason, 'acquire');
  assert.strictEqual(collected, false);
});

test('failed collection: logged, no reports written, worker does not throw', async () => {
  const calls = { report: 0 };
  const logger = captureLogger();
  const out = await createWorker({ config: CONFIG, logger, deps: deps({
    listSealed: () => [],
    collectSnapshot: async () => ({ ok: false, sealed: false, runId: 'X', failedStage: 'verify', error: 'integrity failed' }),
    writeReports: () => { calls.report++; },
  }) }).runCycle();
  assert.strictEqual(out.ok, false);
  assert.strictEqual(calls.report, 0);
  assert.ok(logger.lines.some((l) => l.level === 'error' && l.msg === 'collection failed; package left unsealed'));
});

// ── loop + shutdown ────────────────────────────────────────────────────────────────

test('repeated polling on an UNCHANGED source: many cycles, never a duplicate collection', async () => {
  let cycles = 0; let collected = 0;
  const w = createWorker({ config: CONFIG, logger: captureLogger(), makeSleeper: immediateSleeper, deps: deps({
    checkConnectivity: async () => { cycles++; if (cycles >= 4) w.stop('test'); return { ok: true }; },
    acquireSnapshot: acqOf(BODY),
    ...priorSealed(BODY_HASH), // always identical → always skip
    collectSnapshot: async () => { collected++; return { ok: true, sealed: true, stages: {} }; },
  }) });
  const res = await w.start();
  assert.strictEqual(res.stopped, true);
  assert.strictEqual(cycles, 4);
  assert.strictEqual(collected, 0, 'an unchanging source never produces a duplicate package');
});

test('graceful shutdown: stop() mid-collection finishes the cycle then exits cleanly', async () => {
  const calls = { collect: 0, report: 0 };
  const logger = captureLogger();
  const w = createWorker({ config: CONFIG, logger, makeSleeper: immediateSleeper, deps: deps({
    listSealed: () => [], // changed → collect
    collectSnapshot: async () => { calls.collect++; w.stop('SIGTERM'); return { ok: true, sealed: true, runId: 'N', dir: '/runs/N', stages: {} }; },
    writeReports: () => { calls.report++; },
  }) });
  const res = await w.start();
  assert.strictEqual(res.stopped, true);
  assert.strictEqual(calls.collect, 1);
  assert.strictEqual(calls.report, 1, 'the in-flight collection completed (never partially sealed)');
  assert.ok(logger.lines.some((l) => l.msg === 'sra-worker stopped cleanly'));
});

test('stop() before start() exits immediately without a cycle', async () => {
  let cycles = 0;
  const w = createWorker({ config: CONFIG, logger: captureLogger(), makeSleeper: immediateSleeper, deps: deps({
    checkConnectivity: async () => { cycles++; return { ok: true }; },
  }) });
  w.stop('pre-start');
  await w.start();
  assert.strictEqual(cycles, 0);
});

test('deploy config launches node directly (clean SIGTERM; no npm wrapper noise on redeploy)', () => {
  const cfg = require('../../railway.worker.json');
  assert.strictEqual(cfg.deploy.startCommand, 'node signal-lab/workers/sra-worker.js', 'node started directly');
  assert.ok(!/\bnpm\b/.test(cfg.deploy.startCommand), 'no npm wrapper (npm would log a misleading "npm error signal SIGTERM" on redeploy)');
  assert.strictEqual(cfg.deploy.numReplicas, 1, 'single writer');
  assert.strictEqual(cfg.deploy.restartPolicyType, 'ON_FAILURE');
});
