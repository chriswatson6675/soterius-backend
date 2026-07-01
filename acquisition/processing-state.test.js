'use strict';

// processing-state.test.js — deterministic candidate lifecycle state machine.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  STATES, INITIAL, TRANSITIONS, TERMINAL_STATES,
  isState, isTerminal, nextStates, canTransition, transition,
} = require('./processing-state');

test('initial state is unseen; all states recognised', () => {
  assert.strictEqual(INITIAL, STATES.UNSEEN);
  for (const s of Object.values(STATES)) assert.ok(isState(s), `${s} is a state`);
  assert.ok(!isState('nope'));
  assert.ok(!isState(undefined));
});

test('happy path: unseen → claimed → matched → enriched → persisted → complete', () => {
  const path = [STATES.UNSEEN, STATES.CLAIMED, STATES.MATCHED, STATES.ENRICHED, STATES.PERSISTED, STATES.COMPLETE];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]}`);
    assert.strictEqual(transition(path[i], path[i + 1]), path[i + 1]);
  }
});

test('claimed branches to every match/gate outcome', () => {
  for (const to of [STATES.MATCHED, STATES.NO_MATCH, STATES.AMBIGUOUS, STATES.DISCARDED, STATES.RESEARCH, STATES.FAILED]) {
    assert.ok(canTransition(STATES.CLAIMED, to), `claimed → ${to}`);
  }
});

test('terminal states are exactly complete, no_match, discarded, research', () => {
  const expected = [STATES.COMPLETE, STATES.NO_MATCH, STATES.DISCARDED, STATES.RESEARCH].sort();
  assert.deepStrictEqual([...TERMINAL_STATES].sort(), expected);
  for (const s of expected) { assert.ok(isTerminal(s)); assert.deepStrictEqual(nextStates(s), []); }
  for (const s of [STATES.UNSEEN, STATES.CLAIMED, STATES.MATCHED, STATES.ENRICHED, STATES.PERSISTED, STATES.AMBIGUOUS, STATES.FAILED]) {
    assert.ok(!isTerminal(s), `${s} is not terminal`);
  }
});

test('ambiguous is recoverable: ambiguous → claimed only (Phase 2 re-resolution)', () => {
  assert.ok(canTransition(STATES.AMBIGUOUS, STATES.CLAIMED));
  assert.ok(!canTransition(STATES.AMBIGUOUS, STATES.MATCHED));
  assert.ok(!canTransition(STATES.AMBIGUOUS, STATES.COMPLETE));
  assert.deepStrictEqual(nextStates(STATES.AMBIGUOUS), [STATES.CLAIMED]);
});

test('failed is recoverable: failed → claimed only', () => {
  assert.ok(canTransition(STATES.FAILED, STATES.CLAIMED));
  assert.ok(!canTransition(STATES.FAILED, STATES.MATCHED));
  assert.ok(!canTransition(STATES.FAILED, STATES.COMPLETE));
  assert.ok(canTransition(STATES.MATCHED, STATES.FAILED));
  assert.ok(canTransition(STATES.ENRICHED, STATES.FAILED));
});

test('invalid transitions are rejected explicitly (throw)', () => {
  for (const [from, to] of [
    [STATES.UNSEEN, STATES.MATCHED],     // skips claimed
    [STATES.CLAIMED, STATES.PERSISTED],  // skips matched/enriched
    [STATES.MATCHED, STATES.COMPLETE],   // skips enriched/persisted
    [STATES.PERSISTED, STATES.FAILED],   // persist already succeeded — no failure path
    [STATES.COMPLETE, STATES.CLAIMED],   // terminal
    [STATES.NO_MATCH, STATES.CLAIMED],   // terminal
    [STATES.DISCARDED, STATES.MATCHED],  // terminal
  ]) {
    assert.throws(() => transition(from, to), /invalid transition/, `${from} → ${to} must throw`);
    assert.ok(!canTransition(from, to), `${from} → ${to} canTransition=false`);
  }
});

test('transition / nextStates / isTerminal throw on unknown states; canTransition just returns false', () => {
  assert.throws(() => transition('foo', STATES.CLAIMED), /unknown from state/);
  assert.throws(() => transition(STATES.UNSEEN, 'bar'), /unknown to state/);
  assert.throws(() => nextStates('foo'), /unknown/);
  assert.throws(() => isTerminal('foo'), /unknown/);
  assert.strictEqual(canTransition('foo', STATES.CLAIMED), false);
  assert.strictEqual(canTransition(STATES.UNSEEN, 'bar'), false);
});

test('structural integrity: every state has a transition table; every target is a valid state', () => {
  for (const s of Object.values(STATES)) {
    assert.ok(Array.isArray(TRANSITIONS[s]), `${s} has a transition list`);
    for (const t of TRANSITIONS[s]) assert.ok(isState(t), `${s} → ${t} targets a valid state`);
  }
});

test('immutable: nextStates returns a copy; TRANSITIONS frozen', () => {
  const ns = nextStates(STATES.CLAIMED);
  ns.push('mutation');
  assert.ok(!nextStates(STATES.CLAIMED).includes('mutation'), 'model unaffected by mutating the returned array');
  assert.ok(Object.isFrozen(TRANSITIONS));
  assert.ok(Object.isFrozen(STATES));
});

test('deterministic: repeated calls give identical results', () => {
  assert.strictEqual(transition(STATES.CLAIMED, STATES.MATCHED), transition(STATES.CLAIMED, STATES.MATCHED));
  assert.deepStrictEqual(nextStates(STATES.CLAIMED), nextStates(STATES.CLAIMED));
});
