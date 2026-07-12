'use strict';

// Regression coverage for the ADR-SYS-008 Phase A / ADR-SYS-009 §3.2 canonical
// derivation service. Proves: (1) it wraps scanService.deriveTrustScore rather
// than re-implementing it; (2) the risk-band threshold ladder is not duplicated
// anywhere it now mediates; (3) deriveRating999 / deriveRating999Label produce
// byte-identical output to the calcRating/ratingBand functions previously
// declared independently in pdf-generator/generator.js, across the full
// percentage range — confirming the consolidation changed nothing observable.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const scanService = require('./scanService');
const derivation = require('./scan-derivation-service');

function fixture(overrides = {}) {
  return scanService.SCANNERS.map(def => ({
    key: def.key,
    name: def.name,
    checks: overrides[def.key] ?? [],
  }));
}

// The exact functions removed from pdf-generator/generator.js during this
// consolidation, kept here only as the reference implementation to test parity
// against — not used by any production code path.
function referenceCalcRating(pct) {
  return Math.round((Math.min(100, Math.max(0, pct || 0)) / 100) * 999);
}
function referenceRatingBandLabel(r) {
  if (r >= 899) return 'Excellent';
  if (r >= 749) return 'Good';
  if (r >= 599) return 'Moderate Risk';
  if (r >= 400) return 'High Risk';
  return 'Critical Risk';
}

describe('deriveScanPresentation — delegates to scanService.deriveTrustScore, no re-implementation', () => {
  test('produces the exact same output as calling deriveTrustScore directly', () => {
    const scannerResults = fixture({ ssl: [{ status: 'PASS' }] });
    const viaService = derivation.deriveScanPresentation(scannerResults, '2026-01-01T00:00:00.000Z');
    const direct = scanService.deriveTrustScore(scannerResults, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(viaService, direct);
  });
});

describe('getRiskLevel / getRiskBand — re-exported, not re-implemented', () => {
  test('are the exact same function references as scanService exports', () => {
    assert.equal(derivation.getRiskLevel, scanService.getRiskLevel);
    assert.equal(derivation.getRiskBand, scanService.getRiskBand);
  });
});

describe('resolveRiskLevel — consolidates the score-based fallback previously duplicated in report.js', () => {
  test('returns the given riskLevel verbatim when present, ignoring score', () => {
    assert.equal(derivation.resolveRiskLevel({ riskLevel: 'Good', score: 10 }), 'Good');
  });
  test('falls back to getRiskLevel(score) when riskLevel is absent', () => {
    for (const score of [95, 80, 65, 45, 10]) {
      assert.equal(derivation.resolveRiskLevel({ score }), scanService.getRiskLevel(score));
    }
  });
  test('falls back to Critical Risk when neither riskLevel nor score is present', () => {
    assert.equal(derivation.resolveRiskLevel({}), 'Critical Risk');
    assert.equal(derivation.resolveRiskLevel(), 'Critical Risk');
  });
});

describe('deriveRating999 / deriveRating999Label — parity with the removed pdf-generator thresholds', () => {
  test('deriveRating999 matches the removed calcRating() for every integer percentage 0-100', () => {
    for (let pct = 0; pct <= 100; pct++) {
      assert.equal(derivation.deriveRating999(pct), referenceCalcRating(pct));
    }
  });
  test('deriveRating999Label matches the removed ratingBand() label for every integer percentage 0-100', () => {
    for (let pct = 0; pct <= 100; pct++) {
      const rating = derivation.deriveRating999(pct);
      const expectedLabel = referenceRatingBandLabel(referenceCalcRating(pct));
      assert.equal(derivation.deriveRating999Label(rating), expectedLabel);
    }
  });
  test('clamps out-of-range percentages exactly as the removed calcRating() did', () => {
    assert.equal(derivation.deriveRating999(-10), 0);
    assert.equal(derivation.deriveRating999(150), 999);
    assert.equal(derivation.deriveRating999(undefined), 0);
  });
});
