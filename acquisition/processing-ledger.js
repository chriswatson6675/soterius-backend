'use strict';

// processing-ledger.js — persistent exactly-once ledger for Companies House candidates.
//
// Population Acquisition Layer. Records the Processing State Model state of each
// Companies House company, keyed by company number, in an append-only NDJSON file.
// It is PURE PERSISTENCE — it holds NO business rules:
//   - identity      lives in fca-match.js
//   - eligibility   lives in authorised-status-gate.js
//   - lifecycle     lives in processing-state.js  ← the SOLE authority for valid
//                   transitions; the ledger calls it, never reimplements it.
// It does not call Companies House or the FCA, match, enrich, queue, manage cursors,
// write the Organisation Registry, run workers, retry, or batch.
//
// Durability + resumability: every state change is ONE appended line (the durable
// commit point); the current state is the latest line per company; the full append
// log is the observable processing history. On open the index is rebuilt from the
// file, so exactly-once claiming survives interruption/restart. Single-writer (the
// platform convention), as with the firm-commit commit log.

const fs = require('node:fs');
const path = require('node:path');
const state = require('./processing-state');

function _nowIso(now) { return (now ? now() : new Date()).toISOString(); }

/** Fold one persisted event into the in-memory index. */
function _apply(index, e) {
  const key = String(e.companyNumber);
  const cur = index.get(key);
  if (!cur) index.set(key, { companyNumber: key, state: e.state, createdAt: e.at, updatedAt: e.at, events: [{ state: e.state, at: e.at }] });
  else { cur.state = e.state; cur.updatedAt = e.at; cur.events.push({ state: e.state, at: e.at }); }
}

/**
 * Open (or create) a processing ledger backed by an append-only NDJSON file.
 * @param {Object} opts - { path: string (required), now?: () => Date }
 */
function openLedger(opts = {}) {
  const file = opts.path;
  if (!file) throw new Error('openLedger requires a path');
  const now = opts.now;

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const index = new Map(); // companyNumber -> { companyNumber, state, createdAt, updatedAt, events[] }
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e || e.companyNumber == null || e.state == null || e.at == null) continue;
      _apply(index, e);
    }
  }

  function _append(companyNumber, st, at) {
    const e = { companyNumber: String(companyNumber), state: st, at };
    fs.appendFileSync(file, JSON.stringify(e) + '\n');   // append-only — the durable commit point
    _apply(index, e);
    return e;
  }

  return {
    /** Has this company ever been recorded? */
    has(companyNumber) { return index.has(String(companyNumber)); },

    /** Current processing state, or null if unrecorded. */
    getState(companyNumber) { const r = index.get(String(companyNumber)); return r ? r.state : null; },

    /** Full record (copy) or null. */
    getRecord(companyNumber) {
      const r = index.get(String(companyNumber));
      return r ? { companyNumber: r.companyNumber, state: r.state, createdAt: r.createdAt, updatedAt: r.updatedAt, events: r.events.map((x) => ({ ...x })) } : null;
    },

    /** Observable processing history: ordered state events for a company (copy). */
    history(companyNumber) { const r = index.get(String(companyNumber)); return r ? r.events.map((x) => ({ ...x })) : []; },

    /** All recorded company numbers (copy). */
    companyNumbers() { return [...index.keys()]; },

    /** Number of recorded companies. */
    size() { return index.size; },

    /**
     * Create-or-claim a company for exactly-once processing. Claims iff a transition
     * to CLAIMED is legal from the company's current state (an absent company is
     * treated as INITIAL/unseen) — the legality is decided solely by processing-state:
     *   absent / unseen → create (if absent) then claim
     *   failed          → claim (retry — the state model permits failed → claimed)
     *   otherwise       → rejected (a duplicate/in-flight/terminal company is not re-claimed)
     * @returns {{ claimed: boolean, state: string, reason?: string }}
     */
    claim(companyNumber) {
      const key = String(companyNumber);
      const current = index.has(key) ? index.get(key).state : state.INITIAL;
      if (!state.canTransition(current, state.STATES.CLAIMED)) {
        return { claimed: false, state: current, reason: 'already-claimed' };
      }
      const at = _nowIso(now);
      if (!index.has(key)) _append(key, state.INITIAL, at);   // record creation at the initial (unseen) state
      _append(key, state.STATES.CLAIMED, at);
      return { claimed: true, state: state.STATES.CLAIMED };
    },

    /**
     * Update (transition) a recorded company's state. processing-state is the sole
     * authority: an illegal transition throws, as does an unrecorded company.
     * @returns {string} the new state
     */
    update(companyNumber, toState) {
      const key = String(companyNumber);
      const r = index.get(key);
      if (!r) throw new Error(`unknown company in ledger: ${key}`);
      const to = state.transition(r.state, toState);          // throws on an illegal transition
      _append(key, to, _nowIso(now));
      return to;
    },
  };
}

module.exports = { openLedger };
