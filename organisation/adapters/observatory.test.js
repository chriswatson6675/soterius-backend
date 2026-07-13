'use strict';

// Regression coverage for observatory.js's letterGrade (ADR-SYS-011,
// Scoring Presentation Convergence). Proves letterGrade is now the exact
// same canonical getGrade function, and — the defect the convergence exists
// to close (regression audit finding C-5) — that for every score, the band
// (trustprofile-scan-service.js / legacy-compat's getRiskBand) and the
// grade (this file's letterGrade, consumed by public-trust.js) are always
// derived from the same threshold row, never disagreeing at a boundary.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { letterGrade } = require('./observatory');
const bands = require('../../infra/utils/trust-score-bands');

describe('letterGrade — delegates to the canonical module, not a second ladder', () => {
  test('is the exact same function reference as trust-score-bands.getGrade', () => {
    assert.equal(letterGrade, bands.getGrade);
  });

  test('grade boundaries match trust-score-bands.getGrade for every integer score 0-100', () => {
    for (let score = 0; score <= 100; score++) {
      assert.equal(letterGrade(score), bands.getGrade(score));
    }
  });
});

describe('band/grade consistency — the exact defect ADR-SYS-011 §"Canonical Presentation Model" closes', () => {
  test('a score of 57 (finding C-5\'s reproduction case) is now consistent: "High Risk" and "D" together, never "High Risk" + "C"', () => {
    assert.equal(bands.getRiskBand(57), 'High Risk');
    assert.equal(letterGrade(57), 'D');
  });

  test('for every integer score 0-100, band and grade always come from the same threshold row', () => {
    for (let score = 0; score <= 100; score++) {
      const row = bands.classify(score);
      assert.equal(bands.getRiskBand(score), row.band);
      assert.equal(letterGrade(score), row.grade);
    }
  });
});
