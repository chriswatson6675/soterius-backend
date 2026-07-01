'use strict';

// collection-run.test.js — Phase 2 Collection Run lifecycle tests (IMP-FCA-001 §2).
//
// Verifies: creation, precondition validation, failure on invalid config, run-id
// uniqueness, sealing/immutability on completion, credential never exposed, and
// the absence of any collection behaviour.

const { test } = require('node:test');
const assert = require('node:assert');

const { createRun, STATES, COLLECTOR_VERSION } = require('./collection-run');

const GOOD = { email: 'e@x', apiKey: 'SECRET_KEY', baseUrl: 'https://register.fca.org.uk/services/V0.1', apiVersion: 'V0.1' };

test('createRun: starts in `created` with identity and collector version', () => {
  const run = createRun({ config: GOOD });
  assert.strictEqual(run.state, STATES.CREATED);
  assert.ok(run.id, 'has a run id');
  assert.strictEqual(run.collectorVersion, COLLECTOR_VERSION);
});

test('initialise: valid config → ready, via initialised', () => {
  const run = createRun({ config: GOOD });
  const r = run.initialise();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(run.state, STATES.READY);
  const states = run.history().map((h) => h.state);
  assert.deepStrictEqual(states, [STATES.CREATED, STATES.INITIALISED, STATES.READY]);
});

test('initialise: missing credentials → failed (preconditions only)', () => {
  const run = createRun({ config: { email: null, apiKey: null, baseUrl: GOOD.baseUrl, apiVersion: 'V0.1' } });
  const r = run.initialise();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(run.state, STATES.FAILED);
  assert.ok(r.errors.some((e) => e.includes('FCA_EMAIL')));
  assert.ok(r.errors.some((e) => e.includes('FCA_API_KEY')));
});

test('initialise: null config → failed', () => {
  const run = createRun({ config: null });
  const r = run.initialise();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(run.state, STATES.FAILED);
});

test('complete: ready → completed; snapshot is frozen and sets completedAt', () => {
  const run = createRun({ config: GOOD });
  run.initialise();
  const snap = run.complete();
  assert.strictEqual(run.state, STATES.COMPLETED);
  assert.ok(Object.isFrozen(snap), 'completed snapshot is immutable');
  assert.ok(snap.completedAt, 'completedAt is set');
  assert.strictEqual(snap.runId, run.id);
});

test('complete: idempotent once completed', () => {
  const run = createRun({ config: GOOD });
  run.initialise();
  const a = run.complete();
  const b = run.complete();
  assert.strictEqual(a.runId, b.runId);
  assert.strictEqual(run.state, STATES.COMPLETED);
});

test('complete: rejected before ready', () => {
  const run = createRun({ config: GOOD });
  assert.throws(() => run.complete(), /cannot complete from state 'created'/);
});

test('immutability: cannot initialise after completion (sealed)', () => {
  const run = createRun({ config: GOOD });
  run.initialise();
  run.complete();
  assert.throws(() => run.initialise(), /sealed/);
});

test('run ids are unique', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(createRun({ config: GOOD }).id);
  assert.strictEqual(ids.size, 50);
});

test('injected runId is respected (for resume in a later phase)', () => {
  const run = createRun({ config: GOOD, runId: 'fixed-run-123' });
  assert.strictEqual(run.id, 'fixed-run-123');
});

test('provenance/auth/snapshot NEVER expose the credential [CR-FCA-07]', () => {
  const run = createRun({ config: GOOD });
  run.initialise();
  const blob = JSON.stringify({
    prov: run.provenanceContext(),
    auth: run.authContext(),
    cfg: run.configSummary(),
    snap: run.complete(),
  });
  assert.ok(!blob.includes('SECRET_KEY'), 'API key must never appear');
  // booleans confirm presence without leaking the values
  assert.strictEqual(run.authContext().apiKeyConfigured, true);
  assert.strictEqual(run.authContext().emailConfigured, true);
});

test('provenanceContext carries the run-level CCS-FCA-001 §8 fields', () => {
  const run = createRun({ config: GOOD, collectorVersion: 'test/9.9' });
  const p = run.provenanceContext();
  assert.strictEqual(p.collectorVersion, 'test/9.9');
  assert.strictEqual(p.apiVersion, 'V0.1');
  assert.strictEqual(p.sourceAuthority, 'FCA Financial Services Register');
  assert.ok(p.runId && p.startedAt && p.authContext);
});

test('no collection behaviour is present on the run object', () => {
  const run = createRun({ config: GOOD });
  for (const forbidden of ['observe', 'collect', 'fetch', 'getJson', 'preserve', 'extract', 'paginate', 'retry', 'resume', 'report']) {
    assert.strictEqual(typeof run[forbidden], 'undefined', `run must not expose ${forbidden}()`);
  }
});
