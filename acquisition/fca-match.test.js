'use strict';

// fca-match.test.js — the deterministic match decision encodes the validated PoC logic.

const { test } = require('node:test');
const assert = require('node:assert');

const { normaliseName, decideMatch, OUTCOME } = require('./fca-match');

test('normaliseName: uppercase, &→AND, legal suffixes + punctuation stripped, ws collapsed', () => {
  assert.strictEqual(normaliseName('N. M. Rothschild & Sons Limited'), 'N M ROTHSCHILD AND SONS');
  assert.strictEqual(normaliseName('Dennehy Wealth Ltd'), 'DENNEHY WEALTH');
  assert.strictEqual(normaliseName('  Foo   Bar  PLC '), 'FOO BAR');
});

test('normaliseName: strips the FCA-added (Postcode: …) annotation — the PoC fix', () => {
  assert.strictEqual(
    normaliseName('Hugh James Consultancy Ltd (Postcode: BH1 1JD)'),
    normaliseName('HUGH JAMES CONSULTANCY LIMITED'),
  );
  assert.strictEqual(normaliseName('Hugh James Consultancy Ltd (Postcode: BH1 1JD)'), 'HUGH JAMES CONSULTANCY');
});

test('decideMatch: a single exact normalised match returns MATCH + FRN + status', () => {
  const r = decideMatch('DENNEHY WEALTH LIMITED', [
    { frn: 114360, name: 'Dennehy Wealth Limited', status: 'Authorised' },
    { frn: 999999, name: 'Dennehy Holdings Ltd', status: 'Authorised' },
  ]);
  assert.strictEqual(r.outcome, OUTCOME.MATCH);
  assert.strictEqual(r.frn, '114360');
  assert.strictEqual(r.status, 'Authorised');
});

test('decideMatch: postcode-suffixed hit still matches (regression lock for the PoC defect)', () => {
  const r = decideMatch('HUGH JAMES CONSULTANCY LIMITED', [
    { frn: 704244, name: 'Hugh James Consultancy Ltd (Postcode: BH1 1JD)', status: 'No longer registered as an Appointed Representative' },
  ]);
  assert.strictEqual(r.outcome, OUTCOME.MATCH);
  assert.strictEqual(r.frn, '704244');
  assert.strictEqual(r.status, 'No longer registered as an Appointed Representative', 'status returned verbatim, not interpreted');
});

test('decideMatch: no results / no exact match → NO_MATCH', () => {
  assert.strictEqual(decideMatch('CAPTEC INVESTMENTS LIMITED', []).outcome, OUTCOME.NO_MATCH);
  assert.strictEqual(decideMatch('CAPTEC INVESTMENTS LIMITED', [
    { frn: 1, name: 'Captec Holdings Ltd', status: 'Authorised' },
  ]).outcome, OUTCOME.NO_MATCH);
  assert.strictEqual(decideMatch('', [{ frn: 1, name: '', status: 'Authorised' }]).outcome, OUTCOME.NO_MATCH);
});

test('decideMatch: two distinct FRNs with the same normalised name → AMBIGUOUS', () => {
  const r = decideMatch('IMPARTIAL MORTGAGE ADVICE LIMITED', [
    { frn: 710131, name: 'Impartial Mortgage Advice Limited', status: 'Authorised' },
    { frn: 721503, name: 'Impartial Mortgage Advice Ltd', status: 'Appointed representative' },
  ]);
  assert.strictEqual(r.outcome, OUTCOME.AMBIGUOUS);
  assert.deepStrictEqual(r.candidates.sort(), ['710131', '721503']);
});

test('decideMatch: same FRN appearing twice is one match (deduped), not ambiguous', () => {
  const r = decideMatch('FOO BAR LTD', [
    { frn: 5, name: 'Foo Bar Ltd', status: 'Authorised' },
    { frn: 5, name: 'Foo Bar Limited', status: 'Authorised' },
  ]);
  assert.strictEqual(r.outcome, OUTCOME.MATCH);
  assert.strictEqual(r.frn, '5');
});

test('decideMatch is deterministic: same input → same output', () => {
  const results = [{ frn: 114360, name: 'Dennehy Wealth Limited', status: 'Authorised' }];
  assert.deepStrictEqual(decideMatch('DENNEHY WEALTH LIMITED', results), decideMatch('DENNEHY WEALTH LIMITED', results));
});
