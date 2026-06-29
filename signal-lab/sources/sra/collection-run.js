'use strict';

// collection-run.js — lightweight lifecycle for an SRA snapshot collection run.
//
// SRA Snapshot Collector v0.1 — orchestration support. A pure in-memory state
// machine: identity + a strictly-ordered lifecycle + history. It performs NO I/O,
// NO collection, NO scheduling, NO retries — it only models the run's state so the
// orchestrator (run-snapshot.js) can drive and report it.
//
//   CREATED → OBSERVING → PRESERVING → EXTRACTING → PROVENANCE → VERIFYING → SEALED
//   (or → FAILED from any non-terminal state)
//
// SEALED and FAILED are terminal. Forward transitions must follow the sequence.

const { randomUUID } = require('node:crypto');

const STATES = Object.freeze({
  CREATED: 'created',
  OBSERVING: 'observing',
  PRESERVING: 'preserving',
  EXTRACTING: 'extracting',
  PROVENANCE: 'provenance',
  VERIFYING: 'verifying',
  SEALED: 'sealed',
  FAILED: 'failed',
});

// The single legal forward path (FAILED is reachable from any non-terminal state).
const SEQUENCE = Object.freeze([
  STATES.CREATED, STATES.OBSERVING, STATES.PRESERVING, STATES.EXTRACTING,
  STATES.PROVENANCE, STATES.VERIFYING, STATES.SEALED,
]);

/**
 * Create a run in the CREATED state.
 * @param {Object} [opts] - { runId, now, _uuid }
 */
function createRun(opts = {}) {
  const now = opts.now ?? (() => new Date().toISOString());
  const runId = opts.runId ?? (opts._uuid ?? randomUUID)();
  let state = STATES.CREATED;
  const history = [];

  function record(s, detail) { history.push(detail !== undefined ? { state: s, at: now(), detail } : { state: s, at: now() }); }
  record(state);

  function isTerminal() { return state === STATES.SEALED || state === STATES.FAILED; }

  return {
    get id() { return runId; },
    get state() { return state; },
    history() { return history.map((h) => ({ ...h })); },
    isTerminal,

    /** Advance to the next sequenced state. Throws on an illegal transition. */
    to(target, detail) {
      if (isTerminal()) throw new Error(`run is terminal (${state}); cannot transition to '${target}'`);
      if (!Object.values(STATES).includes(target)) throw new Error(`unknown state '${target}'`);
      if (SEQUENCE[SEQUENCE.indexOf(state) + 1] !== target) throw new Error(`illegal transition ${state} → ${target}`);
      state = target;
      record(state, detail);
      return state;
    },

    /** Move to FAILED from any non-terminal state. */
    fail(reason) {
      if (isTerminal()) throw new Error(`run is terminal (${state}); cannot fail`);
      state = STATES.FAILED;
      record(state, reason);
      return state;
    },

    snapshot() { return { runId, state, history: history.map((h) => ({ ...h })) }; },
  };
}

module.exports = { createRun, STATES, SEQUENCE };
