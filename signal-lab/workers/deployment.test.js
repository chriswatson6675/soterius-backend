'use strict';

// deployment.test.js — production behaviour against a REAL persistent RUN_ROOT.
//
// Simulates Railway restarts by constructing fresh worker instances that read the
// SAME on-disk RUN_ROOT (the volume) and use the REAL Collection Layer (real
// listSealed / loadRunModel / collectSnapshot / writeReports). Only the network
// boundary is faked (checkConnectivity + the Observe transport via _fetch).
//
// Demonstrates: clean startup, restart while idle, restart after a successful
// collection, restart with existing packages, duplicate-snapshot prevention, and
// automatic resume — confirming no packages are lost and no duplicates are created.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorker } = require('./sra-worker');
const { collectSnapshot } = require('../sources/sra/run-snapshot');
const { writeReports } = require('../sources/sra/report');
const { loadRunModel } = require('../sources/sra/snapshot-run-model');
const { listSealed } = require('../sources/sra/collection-package');
const { defineSource } = require('../sources/sra/snapshot-source');

const SRC = defineSource({ recordsPath: ['firms'], officesPath: ['offices'], anchorPath: ['SRA number'], productionTimestampPath: ['productionDate'] });

function snapshotFor(productionDate) {
  return JSON.stringify({ productionDate, firms: [{ 'SRA number': '100001', Name: 'Acme Legal LLP', offices: [{ officeId: '100001-0' }] }] });
}
function okFetch(raw) { return async () => ({ statusCode: 200, headers: {}, bodyBuffer: Buffer.from(raw, 'utf8') }); }
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sra-deploy-')); }
const CLIENT = { baseUrl: 'https://x', subscriptionKey: 'KEY' };
const silent = { error() {}, warn() {}, info() {}, debug() {} };
const immediateSleeper = () => ({ promise: Promise.resolve(), cancel() {} });

// A worker bound to a persistent runRoot. checkConnectivity is faked to advertise
// `liveTs`; collectSnapshot is the REAL collector, given a deterministic runId +
// the faked transport for the advertised snapshot.
function workerFor(runRoot, liveTs, spy = {}) {
  const config = { client: CLIENT, runRoot, checkIntervalMs: 1000, logLevel: 'error', source: SRC };
  return createWorker({
    config, logger: silent, makeSleeper: immediateSleeper,
    deps: {
      checkConnectivity: async () => ({ ok: true, productionTimestamp: liveTs }),
      listSealed, loadRunModel, writeReports,
      collectSnapshot: (args) => { spy.collected = (spy.collected || 0) + 1; return collectSnapshot({ ...args, runId: `SNAP-${liveTs}`, _fetch: okFetch(snapshotFor(liveTs)) }); },
    },
  });
}

// Seed a persistent runRoot with one real sealed package at the given production date.
async function seed(runRoot, productionDate) {
  const r = await collectSnapshot({ config: CLIENT, runRoot, source: SRC, runId: `SNAP-${productionDate}`, _fetch: okFetch(snapshotFor(productionDate)) });
  assert.strictEqual(r.ok && r.sealed, true);
  return r.dir;
}

test('clean startup: first run with empty RUN_ROOT collects and seals one package', async () => {
  const runRoot = tmpRoot();
  const spy = {};
  const w = workerFor(runRoot, '2026-06-28', spy);
  const out = await w.runCycle();
  assert.strictEqual(out.action, 'collected');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(spy.collected, 1);
  assert.strictEqual(listSealed(runRoot).length, 1);
});

test('restart with existing packages + duplicate prevention: same production ts → skip', async () => {
  const runRoot = tmpRoot();
  await seed(runRoot, '2026-06-28');
  assert.strictEqual(listSealed(runRoot).length, 1);

  // "Restart": a brand-new worker instance reading the same volume.
  const spy = {};
  const w = workerFor(runRoot, '2026-06-28', spy);
  const out = await w.runCycle();

  assert.strictEqual(out.action, 'skip');
  assert.strictEqual(out.reason, 'up-to-date');
  assert.strictEqual(spy.collected, undefined, 'no duplicate collection for an already-collected snapshot');
  assert.strictEqual(listSealed(runRoot).length, 1, 'no duplicate package created');
});

test('restart after successful collection: worker resumes and collects only when newer', async () => {
  const runRoot = tmpRoot();
  await seed(runRoot, '2026-06-28');

  // Restart sees a NEWER live snapshot → collects a second, distinct package.
  const w = workerFor(runRoot, '2026-06-29');
  const out = await w.runCycle();
  assert.strictEqual(out.ok, true);

  const sealed = listSealed(runRoot);
  assert.strictEqual(sealed.length, 2, 'a new package for the newer snapshot');
  const tses = sealed.map((p) => loadRunModel(p.dir).manifest.snapshotProductionTimestamp).sort();
  assert.deepStrictEqual(tses, ['2026-06-28', '2026-06-29'], 'two distinct snapshots, no duplicate');
});

test('restart while idle (repeatedly up-to-date) loses nothing and creates nothing', async () => {
  const runRoot = tmpRoot();
  const seededDir = await seed(runRoot, '2026-06-28');
  const before = fs.readFileSync(path.join(seededDir, 'SEALED'), 'utf8');

  // three idle "restarts"
  for (let i = 0; i < 3; i++) {
    const out = await workerFor(runRoot, '2026-06-28').runCycle();
    assert.strictEqual(out.reason, 'up-to-date');
  }

  assert.strictEqual(listSealed(runRoot).length, 1, 'no packages lost or added');
  assert.strictEqual(fs.readFileSync(path.join(seededDir, 'SEALED'), 'utf8'), before, 'existing package untouched');
});

test('worker resumes automatically via the continuous loop, then stops cleanly', async () => {
  const runRoot = tmpRoot();
  await seed(runRoot, '2026-06-28');
  let cycles = 0;
  const config = { client: CLIENT, runRoot, checkIntervalMs: 1000, logLevel: 'error', source: SRC };
  const w = createWorker({
    config, logger: silent, makeSleeper: immediateSleeper,
    deps: {
      checkConnectivity: async () => { cycles++; if (cycles >= 2) w.stop('test'); return { ok: true, productionTimestamp: '2026-06-28' }; },
      listSealed, loadRunModel, writeReports, collectSnapshot,
    },
  });
  const res = await w.start();
  assert.strictEqual(res.stopped, true);
  assert.strictEqual(cycles, 2);
  assert.strictEqual(listSealed(runRoot).length, 1, 'idle resume created no duplicate');
});
