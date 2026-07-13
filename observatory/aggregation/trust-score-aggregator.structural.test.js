'use strict';

// trust-score-aggregator.structural.test.js — ENG-026 §17 AC-1.
//
// Proves the Aggregator never imports a signal_facts_* table, any
// legacy-compat/* module, or any *-quality.js Quality Model directly — its
// only data source is getSignalsForDomain() (organisation/adapters/
// observatory.js) reading signal_quality_*, per ENG-026 §0's "aggregate, do
// not re-score" principle and §2's "no code path capable of reaching a
// signal_facts_* table" requirement.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AGGREGATOR_PATH = path.join(__dirname, 'trust-score-aggregator.js');
const src = fs.readFileSync(AGGREGATOR_PATH, 'utf8');

test('AC-1: never references any signal_facts_* table', () => {
  assert.doesNotMatch(src, /signal_facts_\w+/);
});

test('AC-1: never imports legacy-compat/*', () => {
  assert.doesNotMatch(src, /legacy-compat/);
});

test('AC-1: never imports a *-quality.js Quality Model directly', () => {
  assert.doesNotMatch(src, /require\(['"][^'"]*-quality['"]\)/);
});

test('AC-1: sole data path is getSignalsForDomain via organisation/adapters/observatory', () => {
  assert.match(src, /require\(['"]\.\.\/\.\.\/organisation\/adapters\/observatory['"]\)/);
});

test('trust-score.js no longer exports the retired raw-fact scoring functions', () => {
  const tsSrc = fs.readFileSync(path.join(__dirname, '..', 'baseline', 'trust-score.js'), 'utf8');
  for (const fn of ['scoreSpf', 'scoreDmarc', 'scoreDkim', 'scoreDnssec', 'scoreCaa', 'scoreSecurityHeaders', 'scoreMtaSts', 'scoreSecurityTxt']) {
    assert.doesNotMatch(tsSrc, new RegExp(`function ${fn}\\b`), `${fn} must be deleted, not deprecated-in-place (ENG-026 §11.2)`);
  }
  assert.doesNotMatch(tsSrc, /\bWEIGHTS\s*=/, 'the hand-set WEIGHTS table must be deleted (ENG-026 §11.2)');
});
