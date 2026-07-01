'use strict';

// candidate-processor.js — orchestrate processing of ONE Companies House candidate.
//
// Population Acquisition Layer — the first orchestration component. ORCHESTRATION
// ONLY: it coordinates the frozen authorities and injected I/O. It implements no
// matching, eligibility, lifecycle, or persistence rules of its own.
//   identity     → fca-match.decideMatch
//   eligibility  → authorised-status-gate.classifyStatus
//   lifecycle    → processing-state (enforced via the injected ledger)
//   persistence  → processing-ledger (injected instance)
//   FCA search / FCA enrichment / Organisation Registry write → INJECTED dependencies
//                  (the processor performs none of this I/O itself)
//
// Processes exactly ONE candidate. No acquisition, queues, cursors, workers,
// scheduling, batching, retry loops, or parallelism — those are later concerns.
//
// Error policy:
//   - operational I/O failure (search / enrich / persist throws) → ledger → 'failed',
//     returned as a structured outcome (recoverable later).
//   - an illegal lifecycle transition (ledger.update via processing-state) is NOT
//     swallowed — it propagates, surfacing the violation rather than hiding it.

const { decideMatch, OUTCOME } = require('./fca-match');
const { classifyStatus, DECISION } = require('./authorised-status-gate');
const { STATES } = require('./processing-state');

const PROCESS_OUTCOME = Object.freeze({
  ALREADY_CLAIMED: 'already_claimed',
  NO_MATCH: 'no_match',
  AMBIGUOUS: 'ambiguous',
  DISCARDED: 'discarded',
  RESEARCH: 'research',
  ACQUIRED: 'acquired',
  FAILED: 'failed',
});

function _requireDeps(deps) {
  if (!deps || !deps.ledger || typeof deps.ledger.claim !== 'function' || typeof deps.ledger.update !== 'function') {
    throw new Error('candidate-processor requires deps.ledger (with claim/update)');
  }
  for (const k of ['fcaSearch', 'fcaEnrich', 'persist']) {
    if (typeof deps[k] !== 'function') throw new Error(`candidate-processor requires deps.${k}`);
  }
}

/** Route an operational I/O failure to the failed state (a structured outcome). */
function _fail(ledger, cn, e) {
  ledger.update(cn, STATES.FAILED);   // legal from claimed/matched/enriched; propagates only if unexpectedly illegal
  return { companyNumber: cn, outcome: PROCESS_OUTCOME.FAILED, claimed: true, state: STATES.FAILED, error: e && e.message ? e.message : String(e) };
}

/**
 * Process one Companies House candidate end-to-end.
 * @param {{companyNumber:(string|number), companyName:string}} candidate
 * @param {{ ledger:Object, fcaSearch:(name:string)=>Promise<Array>, fcaEnrich:(frn:string)=>Promise<Object>, persist:(record:Object)=>Promise<*>, config?:Object }} deps
 * @returns {Promise<Object>} structured processing outcome
 */
async function processCandidate(candidate, deps) {
  _requireDeps(deps);
  const { ledger, fcaSearch, fcaEnrich, persist, config = {} } = deps;
  const cn = String(candidate.companyNumber);
  const name = candidate.companyName;

  // 1. claim (exactly-once). A company already claimed/in-flight/terminal is not reprocessed.
  const claim = ledger.claim(cn);
  if (!claim.claimed) {
    return { companyNumber: cn, outcome: PROCESS_OUTCOME.ALREADY_CLAIMED, claimed: false, state: claim.state, reason: claim.reason };
  }

  // 2. FCA search (I/O — failure → failed, not propagated).
  let results;
  try { results = await fcaSearch(name); }
  catch (e) { return _fail(ledger, cn, e); }

  // 3. deterministic match (authority: fca-match). Ledger transitions propagate if illegal.
  const m = decideMatch(name, results);
  if (m.outcome === OUTCOME.NO_MATCH) {
    ledger.update(cn, STATES.NO_MATCH);
    return { companyNumber: cn, outcome: PROCESS_OUTCOME.NO_MATCH, claimed: true, state: STATES.NO_MATCH };
  }
  if (m.outcome === OUTCOME.AMBIGUOUS) {
    ledger.update(cn, STATES.AMBIGUOUS);
    return { companyNumber: cn, outcome: PROCESS_OUTCOME.AMBIGUOUS, claimed: true, state: STATES.AMBIGUOUS, candidates: m.candidates };
  }

  // 4/5. eligibility (authority: authorised-status-gate) on the matched firm's status.
  const gate = classifyStatus(m.status, config);
  if (gate.decision === DECISION.DISCARD) {
    ledger.update(cn, STATES.DISCARDED);
    return { companyNumber: cn, outcome: PROCESS_OUTCOME.DISCARDED, claimed: true, state: STATES.DISCARDED, frn: m.frn, match: m, statusDecision: gate.decision };
  }
  if (gate.decision === DECISION.RESEARCH) {
    ledger.update(cn, STATES.RESEARCH);
    return { companyNumber: cn, outcome: PROCESS_OUTCOME.RESEARCH, claimed: true, state: STATES.RESEARCH, frn: m.frn, match: m, statusDecision: gate.decision };
  }

  // 6. retained → matched → enrich → persist → complete.
  ledger.update(cn, STATES.MATCHED);

  let enrichment;
  try { enrichment = await fcaEnrich(m.frn); }
  catch (e) { return _fail(ledger, cn, e); }
  ledger.update(cn, STATES.ENRICHED);

  try { await persist({ companyNumber: cn, frn: m.frn, ...enrichment }); }
  catch (e) { return _fail(ledger, cn, e); }
  ledger.update(cn, STATES.PERSISTED);

  ledger.update(cn, STATES.COMPLETE);
  return { companyNumber: cn, outcome: PROCESS_OUTCOME.ACQUIRED, claimed: true, state: STATES.COMPLETE, frn: m.frn, match: m, statusDecision: gate.decision, enrichment };
}

module.exports = { processCandidate, PROCESS_OUTCOME };
