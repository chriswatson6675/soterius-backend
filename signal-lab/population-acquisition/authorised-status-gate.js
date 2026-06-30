'use strict';

// authorised-status-gate.js — pure FCA status eligibility classifier.
//
// Population Acquisition Layer. SOLE responsibility: given an FCA register STATUS
// string, decide whether the entry is eligible for the FCA Organisation Registry.
// It knows nothing about Companies House, FRNs, matching, APIs, persistence, queues,
// or acquisition state. Pure + deterministic: no I/O, no HTTP, no database, no side
// effects.
//
// Default policy — faithful to the acquisition objective ("discard non-authorised
// firms, except where explicitly retained for research"):
//   retain   — status is "Authorised" (full FCA authorisation; the target population)
//   discard  — every other status: dependent ("Appointed representative"),
//              registered-not-authorised ("Registered"), any ceased status
//              ("No longer …", "Revoked", "Cancelled", …), and any UNRECOGNISED
//              status (conservative: the registry admits only recognised current
//              authorisation)
//   research — NEVER assigned by default; assigned only to statuses the caller
//              explicitly lists in config.research (the "retained for research"
//              exception — e.g. to study Appointed Representatives or "Registered"
//              payment/e-money firms). retain always wins over research.
//
// The decision AND whether the status was recognised are both returned, so an unknown
// status is an observable fact (recognised:false) rather than a silent discard —
// observable facts before interpretation.

const DECISION = Object.freeze({ RETAIN: 'retain', DISCARD: 'discard', RESEARCH: 'research' });

// Current, independent FULL authorisation — the only status retained by default.
const RETAIN_STATUSES = new Set(['authorised']);

// Recognised current statuses (the register emits these for live entities).
const RECOGNISED_CURRENT = new Set(['authorised', 'registered', 'appointed representative']);

// Recognised terminal/ceased statuses. The register also expresses many ceased
// statuses with a "No longer …" prefix, handled lexically below.
const RECOGNISED_CEASED = new Set(['revoked', 'cancelled', 'expired', 'dissolved', 'applied to cancel']);

/** Deterministic status normalisation: lowercase, whitespace-collapsed, trimmed. */
function normaliseStatus(status) {
  return String(status ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Is this a status the FCA register is known to emit (so the decision is grounded, not a guess)? */
function isRecognised(norm) {
  if (!norm) return false;
  return RECOGNISED_CURRENT.has(norm) || RECOGNISED_CEASED.has(norm) || norm.startsWith('no longer ');
}

/**
 * Classify an FCA status for registry eligibility. Pure; no side effects.
 * @param {string} status - the FCA register status, verbatim
 * @param {Object} [config] - { research?: string[] } statuses (any case) to route to 'research'
 * @returns {{ decision:string, status:string, normalised:string, recognised:boolean }}
 */
function classifyStatus(status, config = {}) {
  const normalised = normaliseStatus(status);
  const research = new Set((config.research || []).map(normaliseStatus));
  const recognised = isRecognised(normalised);

  let decision;
  if (RETAIN_STATUSES.has(normalised)) decision = DECISION.RETAIN;                 // full authorisation — always retained
  else if (normalised.length > 0 && research.has(normalised)) decision = DECISION.RESEARCH; // explicit discard exception
  else decision = DECISION.DISCARD;                                               // dependent / ceased / unrecognised

  return { decision, status, normalised, recognised };
}

module.exports = {
  classifyStatus, normaliseStatus, isRecognised, DECISION,
  RETAIN_STATUSES, RECOGNISED_CURRENT, RECOGNISED_CEASED,
};
