'use strict';

// processing-state.js — the Acquisition Processing State Model (pure state machine).
//
// Population Acquisition Layer. SOLE responsibility: define the deterministic
// lifecycle of ONE Companies House candidate as it progresses through the layer, and
// the pure functions to validate and transition between states. It knows nothing
// about Companies House APIs, FCA APIs, FRNs, databases, queues, Railway, background
// workers, or persistence. No I/O, no side effects, no acquisition logic.
//
// Lifecycle:
//   unseen → claimed → matched → enriched → persisted → complete        (happy path)
//                 │
//                 ├─→ no_match      (no FCA match)                       [terminal]
//                 ├─→ ambiguous     (>1 FCA match — cannot resolve)      [re-resolves → claimed]
//                 ├─→ discarded     (matched but not authorised)         [terminal]
//                 ├─→ research      (matched, routed to research bucket) [terminal]
//                 └─→ failed        (processing error)
//   matched/enriched can also → failed
//   failed → claimed                (retry; permits future resumability — NOT implemented here)
//   ambiguous → claimed             (re-resolution; Phase 2 postcode tie-breaker, see resolve-ambiguous.js)
//
// `matched` means "matched to a SINGLE authorised firm and retained" — i.e. the name
// match and the authorised-status gate both passed; non-retained outcomes diverge to
// their own terminal states so the reason is an observable fact, not a lost detail.
//
// Terminal states have no outgoing transitions. `failed` is deliberately NOT terminal:
// it carries a single recovery transition back to `claimed`, so a candidate's lifecycle
// can express a retry. The retry POLICY and any persistence are later steps.

const STATES = Object.freeze({
  UNSEEN: 'unseen',
  CLAIMED: 'claimed',
  MATCHED: 'matched',
  ENRICHED: 'enriched',
  PERSISTED: 'persisted',
  COMPLETE: 'complete',
  NO_MATCH: 'no_match',
  AMBIGUOUS: 'ambiguous',
  DISCARDED: 'discarded',
  RESEARCH: 'research',
  FAILED: 'failed',
});

const INITIAL = STATES.UNSEEN;
const ALL = new Set(Object.values(STATES));

// from-state → the exhaustive, frozen set of legal next states.
const TRANSITIONS = Object.freeze({
  [STATES.UNSEEN]: Object.freeze([STATES.CLAIMED]),
  [STATES.CLAIMED]: Object.freeze([STATES.MATCHED, STATES.NO_MATCH, STATES.AMBIGUOUS, STATES.DISCARDED, STATES.RESEARCH, STATES.FAILED]),
  [STATES.MATCHED]: Object.freeze([STATES.ENRICHED, STATES.FAILED]),
  [STATES.ENRICHED]: Object.freeze([STATES.PERSISTED, STATES.FAILED]),
  [STATES.PERSISTED]: Object.freeze([STATES.COMPLETE]),
  [STATES.COMPLETE]: Object.freeze([]),
  [STATES.NO_MATCH]: Object.freeze([]),
  [STATES.AMBIGUOUS]: Object.freeze([STATES.CLAIMED]),   // re-resolution path (Phase 2 postcode tie-breaker)
  [STATES.DISCARDED]: Object.freeze([]),
  [STATES.RESEARCH]: Object.freeze([]),
  [STATES.FAILED]: Object.freeze([STATES.CLAIMED]),     // retry (resumability is a later step)
});

const TERMINAL_STATES = Object.freeze(Object.values(STATES).filter((s) => TRANSITIONS[s].length === 0));

/** Is `s` a known state? */
function isState(s) { return ALL.has(s); }

function _assertState(s, label) {
  if (!isState(s)) throw new Error(`unknown ${label} state: ${JSON.stringify(s)}`);
}

/** Legal next states from `from` (a copy; the model is immutable). Throws on unknown state. */
function nextStates(from) { _assertState(from, 'from'); return [...TRANSITIONS[from]]; }

/** Is `s` a terminal state (no outgoing transitions)? Throws on unknown state. */
function isTerminal(s) { _assertState(s, ''); return TRANSITIONS[s].length === 0; }

/** Is `from → to` a legal transition? False (never throws) for unknown states or illegal moves. */
function canTransition(from, to) { return isState(from) && isState(to) && TRANSITIONS[from].includes(to); }

/**
 * Perform a transition. Returns `to` if legal; throws explicitly otherwise.
 * @returns {string} the new state
 */
function transition(from, to) {
  _assertState(from, 'from');
  _assertState(to, 'to');
  if (!TRANSITIONS[from].includes(to)) throw new Error(`invalid transition: ${from} → ${to}`);
  return to;
}

module.exports = {
  STATES, INITIAL, TRANSITIONS, TERMINAL_STATES,
  isState, isTerminal, nextStates, canTransition, transition,
};
