'use strict';

// Canonical Scanner derivation service — ADR-SYS-008 Phase A, ADR-SYS-009 §3.2.
//
// Score and risk-band are not stored evidence; they are a derivation computed
// from the raw, preserved `scanner_results`, produced by exactly ONE service.
// Every call site that previously re-implemented the risk-band threshold ladder
// independently (the PDF generator's 999-point rating conversion, report.js's
// score-based risk-label fallback) now delegates here instead of duplicating
// the 90/75/60/40 cutoffs.
//
// `scanService.deriveTrustScore` remains the actual v1.0 point-summation
// methodology — it stays co-located with SCANNERS/MAX_POINTS, which it is
// tightly bound to. This module is the single consumer-facing derivation entry
// point that wraps it; it does not re-implement the methodology.
//
// Phase A only. This module produces presentation values on demand from raw
// evidence; it changes nothing about what is persisted and does not narrow the
// evidence contract. ADR-SYS-008 Phase B (contract migration) is out of scope.

const scanService = require('./scanService');

// Raw, already-collected scannerResults -> full presentation object (score,
// riskLevel/riskBand, per-category breakdown, scoreObject). The one place
// score/risk-band are generated from evidence.
function deriveScanPresentation(scannerResults, scannedAt) {
  return scanService.deriveTrustScore(scannerResults, scannedAt);
}

// Single canonical risk-band vocabulary — re-exported, never re-implemented.
const getRiskLevel = scanService.getRiskLevel;
const getRiskBand = scanService.getRiskBand;

// Resolves a risk label from either an already-known label or, failing that, a
// score. Consolidates the score-based threshold fallback previously
// re-implemented inline wherever a caller only had a score on hand.
function resolveRiskLevel({ riskLevel, score } = {}) {
  if (riskLevel) return riskLevel;
  if (typeof score === 'number') return getRiskLevel(score);
  return getRiskLevel(0); // 'Critical Risk' — same fallback every prior duplicate used
}

// Rescales the canonical 0-100 percentage onto the product's 0-999 rating
// scale. A pure rescale of the one canonical percentage, not an independent
// scoring computation.
function deriveRating999(percentage) {
  return Math.round((Math.min(100, Math.max(0, percentage || 0)) / 100) * 999);
}

// Risk-band label for a 999-point rating, derived via the SAME canonical
// getRiskBand thresholds (by rescaling the rating back to a percentage) rather
// than a second, independently-declared set of 899/749/599/400 cutoffs.
function deriveRating999Label(rating) {
  return getRiskBand(Math.round((rating / 999) * 100));
}

module.exports = {
  deriveScanPresentation,
  getRiskLevel,
  getRiskBand,
  resolveRiskLevel,
  deriveRating999,
  deriveRating999Label,
};
