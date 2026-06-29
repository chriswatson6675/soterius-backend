'use strict';

// collection-run.test.js — lifecycle state-machine tests.

const { test } = require('node:test');
const assert = require('node:assert');
const { createRun, STATES, SEQUENCE } = require('./collection-run');

test('starts in CREATED with a history entry', () => {
  const run = createRun({ runId: 'R', now: () => 'T' });
  assert.strictEqual(run.id, 'R');
  assert.strictEqual(run.state, STATES.CREATED);
  assert.deepStrictEqual(run.history(), [{ state: 'created', at: 'T' }]);
});

test('advances through the full legal sequence to SEALED', () => {
  const run = createRun({ runId: 'R', now: () => 'T' });
  for (const s of SEQUENCE.slice(1)) run.to(s);
  assert.strictEqual(run.state, STATES.SEALED);
  assert.deepStrictEqual(run.history().map((h) => h.state), [...SEQUENCE]);
  assert.strictEqual(run.isTerminal(), true);
});

test('rejects an illegal (skipping) transition', () => {
  const run = createRun({ runId: 'R' });
  assert.throws(() => run.to(STATES.EXTRACTING), /illegal transition/);
});

test('rejects an unknown state', () => {
  const run = createRun({ runId: 'R' });
  assert.throws(() => run.to('banana'), /unknown state/);
});

test('fail() moves to FAILED from any non-terminal state and records the reason', () => {
  const run = createRun({ runId: 'R', now: () => 'T' });
  run.to(STATES.OBSERVING);
  run.fail('observe: boom');
  assert.strictEqual(run.state, STATES.FAILED);
  assert.deepStrictEqual(run.history().at(-1), { state: 'failed', at: 'T', detail: 'observe: boom' });
});

test('terminal states cannot transition or fail again', () => {
  const sealed = createRun({ runId: 'R' });
  for (const s of SEQUENCE.slice(1)) sealed.to(s);
  assert.throws(() => sealed.to(STATES.SEALED), /terminal/);
  assert.throws(() => sealed.fail('x'), /terminal/);

  const failed = createRun({ runId: 'R2' });
  failed.fail('early');
  assert.throws(() => failed.to(STATES.OBSERVING), /terminal/);
});
