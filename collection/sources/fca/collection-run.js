'use strict';

// collection-run.js — FCA Collection Run lifecycle (orchestration only).
//
// Reference Collector v0.1 — PHASE 2 ONLY (IMP-FCA-001 §2).
//
// A Collection Run is the bounded execution context within which future
// observations will be made (CCD-FCA-001 §3 — the "Collection Run" unit;
// CCS-FCA-001 §2/§4). This module implements ONLY the run's lifecycle: identity,
// version, start moment, precondition validation, run-level provenance, and a
// small state machine. It is deliberately a lightweight orchestration object.
//
// It contains NO collection logic: it does not build endpoints, make requests,
// observe, preserve, extract, paginate, retry, resume, or report (later phases).
// It performs NO network I/O and writes NOTHING to disk — `toManifest()` RETURNS
// run metadata; persisting it is a later phase.
//
// Constitutional conformance (Phase 2 surface):
//   - Preconditions (configuration + authentication context) are validated before
//     a run becomes ready (CCS-FCA-001 §3; CCD-FCA-001 CR-FCA-08 foundation).
//   - The run-level provenance stub carries run id, collector version, API
//     version, start time, source authority, and an authenticated-context flag
//     (CCS-FCA-001 §8) — and NEVER the credential [CR-FCA-07].
//   - A completed run is sealed and immutable (CCD-FCA-001 §6 append-only spirit;
//     CCS-FCA-001 §4 "run completed") [CR-FCA-09/10].
//
// Authority: CCS-FCA-001 §2, §3, §4, §8; CCD-FCA-001 CR-FCA-07/08/09/10;
//   IMP-FCA-001 §2.

const { randomUUID } = require('node:crypto');
const { validateConfig } = require('./fca-client');

const COLLECTOR_VERSION = 'fca-reference-collector/0.1.0';
const SOURCE_AUTHORITY = 'FCA Financial Services Register';

// Lifecycle states (CCS-FCA-001 §4; this phase's required set).
const STATES = Object.freeze({
  CREATED: 'created',
  INITIALISED: 'initialised',
  READY: 'ready',
  FAILED: 'failed',       // preconditions only
  COMPLETED: 'completed', // empty run in Phase 2 (no evidence is collected)
});

/**
 * Create a Collection Run in the `created` state.
 *
 * @param {Object} [options]
 * @param {Object} [options.config]            - config from fca-client.loadConfig()
 * @param {string} [options.collectorVersion]  - defaults to COLLECTOR_VERSION
 * @param {*}      [options.scope]             - opaque, inert run scope (NOT interpreted in Phase 2)
 * @param {string} [options.runId]            - injectable run id (tests)
 * @param {function} [options._uuid]          - injectable uuid generator (tests)
 * @param {function} [options.now]            - injectable clock returning a Date (tests)
 * @returns {CollectionRun}
 */
function createRun(options = {}) {
  const now = options.now ?? (() => new Date());
  const uuid = options._uuid ?? randomUUID;
  const runId = options.runId ?? uuid();
  const config = options.config ?? null;
  const collectorVersion = options.collectorVersion ?? COLLECTOR_VERSION;
  const scope = options.scope ?? null; // stored verbatim; never expanded/traversed in Phase 2

  const startedAt = now().toISOString();
  const history = [];
  let state = STATES.CREATED;
  let sealed = false;

  function transition(to, detail) {
    state = to;
    history.push(detail !== undefined ? { state: to, at: now().toISOString(), detail } : { state: to, at: now().toISOString() });
  }
  transition(STATES.CREATED);

  // Non-secret authentication descriptor (the credential is NEVER included) [CR-FCA-07].
  function authContext() {
    return {
      method: 'X-Auth-Email + X-Auth-Key (header)',
      emailConfigured: !!(config && config.email),
      apiKeyConfigured: !!(config && config.apiKey),
    };
  }

  function configSummary() {
    if (!config) return null;
    return {
      baseUrl: config.baseUrl ?? null,
      apiVersion: config.apiVersion ?? null,
      emailConfigured: !!config.email,
      apiKeyConfigured: !!config.apiKey,
    };
  }

  // Run-level provenance stub future observations will extend (CCS-FCA-001 §8).
  function provenanceContext() {
    return {
      runId,
      collectorVersion,
      apiVersion: config ? (config.apiVersion ?? null) : null,
      startedAt,
      sourceAuthority: SOURCE_AUTHORITY,
      authContext: authContext(),
    };
  }

  function snapshot() {
    const snap = {
      runId,
      state,
      collectorVersion,
      apiVersion: config ? (config.apiVersion ?? null) : null,
      startedAt,
      completedAt: state === STATES.COMPLETED ? history[history.length - 1].at : null,
      sourceAuthority: SOURCE_AUTHORITY,
      authContext: authContext(),
      configSummary: configSummary(),
      scope,
      environment: { node: process.version, platform: process.platform },
      history: history.map((h) => ({ ...h })),
    };
    return state === STATES.COMPLETED ? Object.freeze(snap) : snap;
  }

  const run = {
    get id() { return runId; },
    get state() { return state; },
    get collectorVersion() { return collectorVersion; },

    history() { return history.map((h) => ({ ...h })); },
    authContext,
    configSummary,
    provenanceContext,
    snapshot,

    /** Returns run metadata (a manifest object). Does NOT write to disk (persistence is a later phase). */
    toManifest() { return snapshot(); },

    /**
     * Validate preconditions (configuration + authentication context). No network.
     * Moves created → initialised → ready, or created → failed.
     * @returns {{ ok: boolean, errors: string[] }}
     */
    initialise() {
      if (sealed || state === STATES.COMPLETED) throw new Error('run is sealed; cannot initialise');
      if (state !== STATES.CREATED) throw new Error(`cannot initialise from state '${state}'`);
      transition(STATES.INITIALISED);

      // Preconditions (CCS-FCA-001 §3). validateConfig also asserts the auth
      // context is present (email + apiKey). A LIVE auth probe is deliberately
      // NOT done here — it would be endpoint traversal (out of Phase 2 scope);
      // the first real request in a later phase surfaces live auth failures.
      const { errors } = validateConfig(config);
      if (errors.length > 0) {
        transition(STATES.FAILED, errors);
        return { ok: false, errors };
      }
      transition(STATES.READY);
      return { ok: true, errors: [] };
    },

    /**
     * Seal the run (empty completion in Phase 2). Idempotent once completed.
     * Only valid from `ready`. After completion the run is immutable.
     * @returns {Object} frozen run snapshot
     */
    complete() {
      if (state === STATES.COMPLETED) return snapshot();
      if (state !== STATES.READY) throw new Error(`cannot complete from state '${state}'`);
      transition(STATES.COMPLETED);
      sealed = true;
      return snapshot();
    },
  };

  return run;
}

module.exports = { createRun, STATES, COLLECTOR_VERSION, SOURCE_AUTHORITY };

/**
 * @typedef {Object} CollectionRun
 * @property {string} id
 * @property {string} state
 * @property {string} collectorVersion
 * @property {function(): Object[]} history
 * @property {function(): Object} authContext
 * @property {function(): (Object|null)} configSummary
 * @property {function(): Object} provenanceContext
 * @property {function(): Object} snapshot
 * @property {function(): Object} toManifest
 * @property {function(): {ok: boolean, errors: string[]}} initialise
 * @property {function(): Object} complete
 */
