'use strict';

// candidate-processor.test.js — single-candidate orchestration over the frozen modules.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { processCandidate, PROCESS_OUTCOME } = require('./candidate-processor');
const { openLedger } = require('./processing-ledger');
const { STATES } = require('./processing-state');

function tmpLedger() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-proc-')), 'ledger.ndjson');
  let t = 1_700_000_000_000;
  return openLedger({ path: file, now: () => new Date(t += 1000) });
}
// build deps with recording stubs
function makeDeps(over = {}) {
  const calls = { search: [], enrich: [], persist: [] };
  const deps = {
    ledger: over.ledger || tmpLedger(),
    fcaSearch: over.fcaSearch || (async (name) => { calls.search.push(name); return over.results || []; }),
    fcaEnrich: over.fcaEnrich || (async (frn) => { calls.enrich.push(frn); return { firmName: 'X', website: 'x.co.uk', permissions: 7 }; }),
    persist: over.persist || (async (rec) => { calls.persist.push(rec); }),
    config: over.config,
  };
  return { deps, calls };
}
const cand = (companyNumber, companyName) => ({ companyNumber, companyName });

test('successful authorised acquisition → ACQUIRED, ledger reaches complete, persisted with enrichment', async () => {
  const { deps, calls } = makeDeps({ results: [{ frn: '114360', name: 'Dennehy Wealth Limited', status: 'Authorised' }] });
  const r = await processCandidate(cand('09623642', 'DENNEHY WEALTH LIMITED'), deps);

  assert.strictEqual(r.outcome, PROCESS_OUTCOME.ACQUIRED);
  assert.strictEqual(r.state, STATES.COMPLETE);
  assert.strictEqual(r.frn, '114360');
  assert.deepStrictEqual(r.enrichment, { firmName: 'X', website: 'x.co.uk', permissions: 7 });
  assert.strictEqual(deps.ledger.getState('09623642'), STATES.COMPLETE);
  assert.deepStrictEqual(deps.ledger.history('09623642').map((e) => e.state),
    [STATES.UNSEEN, STATES.CLAIMED, STATES.MATCHED, STATES.ENRICHED, STATES.PERSISTED, STATES.COMPLETE]);
  assert.deepStrictEqual(calls.persist, [{ companyNumber: '09623642', frn: '114360', firmName: 'X', website: 'x.co.uk', permissions: 7 }]);
  assert.deepStrictEqual(calls.enrich, ['114360']);
});

test('no FCA match → NO_MATCH terminal; enrichment/persist never called', async () => {
  const { deps, calls } = makeDeps({ results: [{ frn: '1', name: 'Totally Different Ltd', status: 'Authorised' }] });
  const r = await processCandidate(cand('A1', 'CAPTEC INVESTMENTS LIMITED'), deps);
  assert.strictEqual(r.outcome, PROCESS_OUTCOME.NO_MATCH);
  assert.strictEqual(deps.ledger.getState('A1'), STATES.NO_MATCH);
  assert.strictEqual(calls.enrich.length, 0);
  assert.strictEqual(calls.persist.length, 0);
});

test('ambiguous FCA match → AMBIGUOUS terminal with candidates', async () => {
  const { deps } = makeDeps({ results: [
    { frn: '710131', name: 'Impartial Mortgage Advice Limited', status: 'Authorised' },
    { frn: '721503', name: 'Impartial Mortgage Advice Ltd', status: 'Appointed representative' },
  ] });
  const r = await processCandidate(cand('A2', 'IMPARTIAL MORTGAGE ADVICE LIMITED'), deps);
  assert.strictEqual(r.outcome, PROCESS_OUTCOME.AMBIGUOUS);
  assert.strictEqual(deps.ledger.getState('A2'), STATES.AMBIGUOUS);
  assert.deepStrictEqual(r.candidates.sort(), ['710131', '721503']);
});

test('matched but non-authorised status → DISCARDED; enrichment never called', async () => {
  const { deps, calls } = makeDeps({ results: [{ frn: '760775', name: 'HCP Finance Limited', status: 'Appointed representative' }] });
  const r = await processCandidate(cand('A3', 'HCP FINANCE LIMITED'), deps);
  assert.strictEqual(r.outcome, PROCESS_OUTCOME.DISCARDED);
  assert.strictEqual(r.statusDecision, 'discard');
  assert.strictEqual(r.frn, '760775');
  assert.strictEqual(deps.ledger.getState('A3'), STATES.DISCARDED);
  assert.strictEqual(calls.enrich.length, 0);
});

test('research config routes a matched discardable status → RESEARCH', async () => {
  const { deps } = makeDeps({ results: [{ frn: '502597', name: 'Worldpay AP Ltd', status: 'Registered' }], config: { research: ['Registered'] } });
  const r = await processCandidate(cand('A4', 'WORLDPAY AP LTD'), deps);
  assert.strictEqual(r.outcome, PROCESS_OUTCOME.RESEARCH);
  assert.strictEqual(deps.ledger.getState('A4'), STATES.RESEARCH);
});

test('duplicate company already claimed → ALREADY_CLAIMED; no search performed', async () => {
  const { deps, calls } = makeDeps({ results: [{ frn: '1', name: 'X', status: 'Authorised' }] });
  deps.ledger.claim('A5');                                   // pre-claimed
  const r = await processCandidate(cand('A5', 'ANYTHING LTD'), deps);
  assert.strictEqual(r.outcome, PROCESS_OUTCOME.ALREADY_CLAIMED);
  assert.strictEqual(r.claimed, false);
  assert.strictEqual(r.state, STATES.CLAIMED);
  assert.strictEqual(calls.search.length, 0, 'no FCA search for an already-claimed company');
});

test('enrichment failure → FAILED; persist never called; ledger at failed', async () => {
  const { deps, calls } = makeDeps({
    results: [{ frn: '114360', name: 'Dennehy Wealth Limited', status: 'Authorised' }],
    fcaEnrich: async () => { throw new Error('FCA enrich 503'); },
  });
  const r = await processCandidate(cand('A6', 'DENNEHY WEALTH LIMITED'), deps);
  assert.strictEqual(r.outcome, PROCESS_OUTCOME.FAILED);
  assert.match(r.error, /enrich 503/);
  assert.strictEqual(deps.ledger.getState('A6'), STATES.FAILED);
  assert.strictEqual(calls.persist.length, 0);
  assert.deepStrictEqual(deps.ledger.history('A6').map((e) => e.state),
    [STATES.UNSEEN, STATES.CLAIMED, STATES.MATCHED, STATES.FAILED]);
});

test('search failure → FAILED before any match', async () => {
  const { deps } = makeDeps({ fcaSearch: async () => { throw new Error('search timeout'); } });
  const r = await processCandidate(cand('A7', 'ANY LTD'), deps);
  assert.strictEqual(r.outcome, PROCESS_OUTCOME.FAILED);
  assert.strictEqual(deps.ledger.getState('A7'), STATES.FAILED);
});

test('invalid lifecycle transition propagates (not swallowed)', async () => {
  // mock ledger that claims then throws an illegal-transition error on update
  const mockLedger = {
    claim: () => ({ claimed: true, state: STATES.CLAIMED }),
    update: () => { throw new Error('invalid transition: claimed → complete'); },
  };
  const { deps } = makeDeps({ ledger: mockLedger, results: [] /* → no_match → update throws */ });
  await assert.rejects(processCandidate(cand('A8', 'ANY LTD'), deps), /invalid transition/);
});

test('missing dependencies are rejected', async () => {
  await assert.rejects(processCandidate(cand('A9', 'X'), { fcaSearch: () => {}, fcaEnrich: () => {}, persist: () => {} }), /requires deps.ledger/);
  const { deps } = makeDeps();
  delete deps.fcaEnrich;
  await assert.rejects(processCandidate(cand('A9', 'X'), deps), /requires deps.fcaEnrich/);
});
