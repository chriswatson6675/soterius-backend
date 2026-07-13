'use strict';

// Regression coverage for trust-score-bands.js (ADR-SYS-011, Scoring
// Presentation Convergence). Proves: (1) the canonical band boundaries are
// byte-identical to legacy-scan-engine.js's pre-convergence 90/75/60/40
// ladder (so no historical `scans` row's derived risk band changes), (2)
// getRiskBand and getRiskLevel are the exact same function (the duplication
// that used to exist inside legacy-scan-engine.js is gone), and (3) grade
// and band are always semantically consistent for the same score — the
// exact defect this module exists to close.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { getRiskBand, getRiskLevel, getGrade, classify, THRESHOLDS } = require('./trust-score-bands');

describe('getRiskBand / getRiskLevel — canonical 90/75/60/40 boundaries', () => {
  test('band boundaries match the pre-convergence legacy-scan-engine.js ladder exactly', () => {
    for (const fn of [getRiskBand, getRiskLevel]) {
      assert.equal(fn(100), 'Excellent');
      assert.equal(fn(90), 'Excellent');
      assert.equal(fn(89), 'Good');
      assert.equal(fn(75), 'Good');
      assert.equal(fn(74), 'Moderate Risk');
      assert.equal(fn(60), 'Moderate Risk');
      assert.equal(fn(59), 'High Risk');
      assert.equal(fn(40), 'High Risk');
      assert.equal(fn(39), 'Critical Risk');
      assert.equal(fn(0), 'Critical Risk');
    }
  });

  test('getRiskLevel is the exact same function reference as getRiskBand — not a second implementation', () => {
    assert.equal(getRiskLevel, getRiskBand);
  });
});

describe('getGrade — derived from the SAME thresholds as getRiskBand, not a second ladder', () => {
  test('grade boundaries align exactly with band boundaries', () => {
    const cases = [
      [100, 'A'], [90, 'A'], [89, 'B'], [75, 'B'],
      [74, 'C'], [60, 'C'], [59, 'D'], [40, 'D'],
      [39, 'E'], [0, 'E'],
    ];
    for (const [score, grade] of cases) assert.equal(getGrade(score), grade);
  });
});

describe('classify — band and grade are always consistent for the same score (the defect this module closes)', () => {
  test('every integer score 0-100 yields a band and grade from the same threshold row', () => {
    for (let score = 0; score <= 100; score++) {
      const row = classify(score);
      assert.equal(getRiskBand(score), row.band);
      assert.equal(getGrade(score), row.grade);
      // Previously (regression audit finding C-5): band used 90/75/60/40,
      // grade used 90/75/55/35 — a score of 57 was simultaneously "High
      // Risk" (band) and "C" (grade), a boundary-region contradiction. Prove
      // that specific case, and its neighbours, are now consistent.
      if (score === 57) {
        assert.equal(row.band, 'High Risk');
        assert.equal(row.grade, 'D');
      }
    }
  });

  test('handles non-numeric / out-of-range input the same way the legacy ladder always did (defaults to the lowest band)', () => {
    assert.equal(getRiskBand(undefined), 'Critical Risk');
    assert.equal(getRiskBand(NaN), 'Critical Risk');
    assert.equal(getGrade(undefined), 'E');
  });

  test('THRESHOLDS is the one exported table — no second table exists to drift out of sync', () => {
    assert.equal(THRESHOLDS.length, 5);
    assert.deepEqual(THRESHOLDS.map((t) => t.min), [90, 75, 60, 40, 0]);
  });
});
