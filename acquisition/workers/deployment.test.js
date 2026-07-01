'use strict';

// deployment.test.js — content-hash de-duplication (TD-1) against a REAL persistent
// RUN_ROOT and the REAL, UNCHANGED Collection Layer. Only the network boundary is
// faked (checkConnectivity + the Observe transport via _fetch).
//
// Confirms: identical snapshots never produce duplicate Collection Packages; changed
// snapshots always produce a new one; a corrupted previous package falls back to
// collecting; repeated polling on an unchanged source loses nothing and adds nothing.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorker } = require('./sra-worker');
const { collectSnapshot } = require('../../collection/sources/sra/run-snapshot');
const { acquireSnapshot } = require('../../collection/sources/sra/acquire-snapshot');
const { writeReports } = require('../../collection/sources/sra/report');
const { loadRunModel } = require('../../collection/sources/sra/snapshot-run-model');
const { listSealed, readSeal } = require('../../collection/sources/sra/collection-package');
const { defineSource } = require('../../collection/sources/sra/snapshot-source');
const { rawIndexPath } = require('../../collection/sources/sra/evidence-path');

const SRC = defineSource({ recordsPath: ['Organisations'], officesPath: ['Offices'], anchorPath: ['SraNumber'], productionTimestampPath: ['ProductionDate'] });
const CLIENT = { baseUrl: 'https://x', subscriptionKey: 'KEY' };
const silent = { error() {}, warn() {}, info() {}, debug() {} };
const immediateSleeper = () => ({ promise: Promise.resolve(), cancel() {} });

function snapshot(name) {
  return JSON.stringify({ Count: 1, Organisations: [{ SraNumber: 111, PracticeName: name, Offices: [{ OfficeId: 1, Postcode: 'WF10 3RE' }] }] });
}
const SNAPSHOT_A = snapshot('Acme Legal LLP');
const SNAPSHOT_B = snapshot('Beta Law Ltd'); // different bytes → different content hash
function okFetch(body) { return async () => ({ statusCode: 200, headers: {}, bodyBuffer: Buffer.from(body, 'utf8') }); }
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sra-td1-')); }

// A worker bound to a persistent runRoot. Real Collection Layer; only the network is faked.
function workerFor(runRoot, body, spy = {}) {
  const config = { client: CLIENT, runRoot, checkIntervalMs: 1000, logLevel: 'error', source: SRC };
  return createWorker({
    config, logger: silent, makeSleeper: immediateSleeper,
    deps: {
      checkConnectivity: async () => ({ ok: true }),
      acquireSnapshot: (a) => acquireSnapshot({ ...a, _fetch: okFetch(body) }),
      collectSnapshot: (a) => { spy.collected = (spy.collected || 0) + 1; return collectSnapshot(a); }, // a.deps.acquireSnapshot is injected by the worker
      writeReports, loadRunModel, listSealed, readSeal,
    },
  });
}

// Seed a real sealed package directly (simulates an earlier run on the volume).
async function seed(runRoot, body, runId) {
  const r = await collectSnapshot({ config: CLIENT, runRoot, source: SRC, runId, _fetch: okFetch(body) });
  assert.ok(r.ok && r.sealed, 'seed package sealed');
  return r.dir;
}

test('first collection: empty RUN_ROOT → collects and seals exactly one package', async () => {
  const runRoot = tmpRoot();
  const spy = {};
  const out = await workerFor(runRoot, SNAPSHOT_A, spy).runCycle();
  assert.strictEqual(out.action, 'collected');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(spy.collected, 1);
  assert.strictEqual(listSealed(runRoot).length, 1);
});

test('unchanged snapshot across "restart": identical content → skip, NO duplicate package', async () => {
  const runRoot = tmpRoot();
  await seed(runRoot, SNAPSHOT_A, 'SEED');
  assert.strictEqual(listSealed(runRoot).length, 1);

  const spy = {};
  const out = await workerFor(runRoot, SNAPSHOT_A, spy).runCycle(); // same bytes
  assert.strictEqual(out.action, 'skip');
  assert.strictEqual(out.reason, 'unchanged');
  assert.strictEqual(spy.collected, undefined, 'no collection for an identical snapshot');
  assert.strictEqual(listSealed(runRoot).length, 1, 'no duplicate package created');
});

test('changed snapshot: different content → always a new package (distinct raw hashes)', async () => {
  const runRoot = tmpRoot();
  await seed(runRoot, SNAPSHOT_A, 'SEED');

  const spy = {};
  const out = await workerFor(runRoot, SNAPSHOT_B, spy).runCycle(); // different bytes
  assert.strictEqual(out.ok, true);
  assert.strictEqual(spy.collected, 1);

  const sealed = listSealed(runRoot);
  assert.strictEqual(sealed.length, 2, 'a new package for the changed snapshot');
  const hashes = sealed.map((p) => loadRunModel(p.dir).rawIndex.map((r) => r.sha256).join(',')).sort();
  assert.notStrictEqual(hashes[0], hashes[1], 'the two packages have distinct raw content hashes');
});

test('corrupted previous package (empty raw index) → falls back to collecting', async () => {
  const runRoot = tmpRoot();
  const seededDir = await seed(runRoot, SNAPSHOT_A, 'SEED');
  fs.writeFileSync(rawIndexPath(seededDir), ''); // corrupt: recorded hash now unreadable

  const spy = {};
  const out = await workerFor(runRoot, SNAPSHOT_A, spy).runCycle();
  assert.strictEqual(out.action, 'collected', 'no comparable prior hash → collect (safe)');
  assert.strictEqual(spy.collected, 1);
  assert.strictEqual(listSealed(runRoot).length, 2);
});

test('repeated polling on an unchanged source loses nothing and creates nothing', async () => {
  const runRoot = tmpRoot();
  const seededDir = await seed(runRoot, SNAPSHOT_A, 'SEED');
  const before = fs.readFileSync(path.join(seededDir, 'SEALED'), 'utf8');

  for (let i = 0; i < 3; i++) {
    const out = await workerFor(runRoot, SNAPSHOT_A).runCycle();
    assert.strictEqual(out.reason, 'unchanged');
  }
  assert.strictEqual(listSealed(runRoot).length, 1, 'no packages lost or added');
  assert.strictEqual(fs.readFileSync(path.join(seededDir, 'SEALED'), 'utf8'), before, 'existing package untouched');
});
