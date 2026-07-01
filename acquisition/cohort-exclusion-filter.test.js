'use strict';

// cohort-exclusion-filter.test.js — deterministic cohort exclusion before the processor.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadCohortIndex, createCohortExclusionFilter, withCohortExclusion, DECISION, REASON } = require('./cohort-exclusion-filter');
const { runCandidateSource } = require('./candidate-source-runner');
const { normaliseName } = require('./fca-match');

function indexOf(ifn = [], pra = []) {
  return { ifNames: new Set(ifn.map(normaliseName)), praNames: new Set(pra.map(normaliseName)) };
}
const cand = (companyNumber, companyName) => ({ companyNumber, companyName });

test('an IF-cohort firm is skipped with reason if_cohort', () => {
  const filter = createCohortExclusionFilter(indexOf(['Dennehy Wealth Limited'], []));
  assert.deepStrictEqual(filter(cand('1', 'DENNEHY WEALTH LIMITED')), { decision: DECISION.SKIP, reason: REASON.IF });
});

test('a PRA-cohort firm is skipped with reason pra_cohort', () => {
  const filter = createCohortExclusionFilter(indexOf([], ['Leek United Building Society']));
  assert.deepStrictEqual(filter(cand('2', 'Leek United Building Society')), { decision: DECISION.SKIP, reason: REASON.PRA });
});

test('an unknown company proceeds (process, reason null)', () => {
  const filter = createCohortExclusionFilter(indexOf(['Known Ltd'], ['Bank Plc']));
  assert.deepStrictEqual(filter(cand('3', 'Brand New Adviser Ltd')), { decision: DECISION.PROCESS, reason: null });
});

test('matching uses the frozen normaliser (casing/punctuation/suffix insensitive)', () => {
  const filter = createCohortExclusionFilter(indexOf(['N. M. Rothschild & Sons Limited'], []));
  assert.strictEqual(filter(cand('4', 'n m rothschild and sons ltd')).decision, DECISION.SKIP);
});

test('withCohortExclusion: a skipped candidate NEVER calls the processor (no FCA/ledger/registry)', async () => {
  let processCalls = 0;
  const process = async () => { processCalls++; return { outcome: 'acquired' }; };
  const filter = createCohortExclusionFilter(indexOf(['Known Ltd'], []));
  const wrapped = withCohortExclusion(filter, process);

  const skipped = await wrapped(cand('5', 'KNOWN LIMITED'), {});
  assert.deepStrictEqual(skipped, { companyNumber: '5', outcome: 'skipped_if', skipped: true, reason: REASON.IF });
  assert.strictEqual(processCalls, 0, 'processor not invoked for a skipped candidate');

  const proceeded = await wrapped(cand('6', 'OTHER LIMITED'), {});
  assert.strictEqual(proceeded.outcome, 'acquired');
  assert.strictEqual(processCalls, 1, 'processor invoked for a proceeding candidate');
});

test('loadCohortIndex builds name sets from IF + PRA files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohort-'));
  const ifPath = path.join(dir, 'investment-firms.csv');
  fs.writeFileSync(ifPath, 'FRN,Organisation Name,LEI,Status\n835233,"CHETWOOD INVESTMENT MANAGEMENT LIMITED",,Authorised\n');
  const praPath = path.join(dir, 'pra.csv');
  fs.writeFileSync(praPath, 'BANK OF ENGLAND (PRA),,\nDisclaimer row,,\nLeek United Building Society,100014,Active\n');

  const idx = loadCohortIndex({ ifPath, praPaths: [praPath] });
  assert.ok(idx.ifNames.has(normaliseName('Chetwood Investment Management Limited')));
  assert.ok(idx.praNames.has(normaliseName('Leek United Building Society')));

  const filter = createCohortExclusionFilter(idx);
  assert.strictEqual(filter(cand('x', 'CHETWOOD INVESTMENT MANAGEMENT LTD')).reason, REASON.IF);
  assert.strictEqual(filter(cand('y', 'LEEK UNITED BUILDING SOCIETY')).reason, REASON.PRA);
});

test('integration: runner tallies skipped_if / skipped_pra and only processes the rest', async () => {
  const filter = createCohortExclusionFilter(indexOf(['IF Firm Ltd'], ['PRA Bank Plc']));
  const seen = [];
  const realProcess = async (c) => { seen.push(c.companyNumber); return { companyNumber: c.companyNumber, outcome: 'no_match' }; };
  const process = withCohortExclusion(filter, realProcess);

  const source = [cand('A', 'IF Firm Ltd'), cand('B', 'PRA Bank Plc'), cand('C', 'New Adviser Ltd')];
  const r = await runCandidateSource(source, {}, { process });

  assert.strictEqual(r.processed, 3);
  assert.deepStrictEqual(r.counts, { skipped_if: 1, skipped_pra: 1, no_match: 1 });
  assert.deepStrictEqual(seen, ['C'], 'only the non-cohort company reached the real processor');
});
