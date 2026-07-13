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
// `legacyEngine.deriveTrustScore` (backend/api/legacy-compat/legacy-scan-engine.js,
// formerly scanService.js — renamed by ADR-SYS-011) remains the actual v1.0
// point-summation methodology — it stays co-located with SCANNERS/MAX_POINTS,
// which it is tightly bound to. This module is the single consumer-facing
// derivation entry point that wraps it; it does not re-implement the
// methodology.
//
// Phase A only. This module produces presentation values on demand from raw
// evidence; it changes nothing about what is persisted and does not narrow the
// evidence contract. ADR-SYS-008 Phase B (contract migration) is out of scope.
//
// ── scoring_version dispatch (ADR-SYS-011, Legacy Scanner Retirement) ──────
// A persisted `scans` row can now come from either of two tiers, distinguished
// by its `scoring_version` column:
//   'trustprofile-v1'            -> Observatory Quality Model tier (the
//                                    canonical, current production engine —
//                                    see trustprofile-scan-service.js)
//   'v1.0' / 'legacy-scan-v1'    -> the historical compatibility engine
//                                    (legacy-compat/legacy-scan-engine.js).
//                                    'v1.0' is the tag every row written
//                                    before this migration already carries
//                                    and is NEVER rewritten; 'legacy-scan-v1'
//                                    is accepted as an explicit alias for any
//                                    future caller that wants to tag legacy
//                                    output unambiguously. Both route to the
//                                    exact same historical derivation.
// deriveScanPresentationForRow() is the ONE place this dispatch happens —
// every consumer that re-presents a persisted `scans` row (report.js,
// scan.js's submit-gate) must call it instead of re-deriving inline.

const legacyEngine = require('../legacy-compat/legacy-scan-engine');

const TRUSTPROFILE_SCORING_VERSION = 'trustprofile-v1';
const LEGACY_SCORING_VERSION = 'legacy-scan-v1';

// Raw, already-collected legacy-tier scannerResults -> full presentation
// object (score, riskLevel/riskBand, per-category breakdown, scoreObject).
// Unchanged since ADR-SYS-008 Phase A — legacy tier only. New code that
// re-presents a persisted `scans` row should call
// deriveScanPresentationForRow() instead, which dispatches to this function
// for the legacy tier and to presentTrustProfileScan() for the canonical
// Observatory tier.
function deriveScanPresentation(scannerResults, scannedAt) {
  return legacyEngine.deriveTrustScore(scannerResults, scannedAt);
}

// A persisted trustprofile-v1 `scans` row already carries its final,
// computed presentation in `score_object`/`scanner_results` (written once,
// at scan time, by trustprofile-scan-service.js) — this re-presents that
// stored derivation, it does not re-run the Observatory pipeline or
// recompute a score. Mirrors deriveScanPresentation()'s legacy-tier
// contract (score, riskLevel, scannedAt, totalPoints, maxPoints, scanners,
// scoreObject) so both tiers are interchangeable to every existing caller.
function presentTrustProfileScan(scanRow) {
  const so = (scanRow && scanRow.score_object) || {};
  return {
    score: so.overallScore ?? 0,
    riskLevel: so.riskBand || 'Critical Risk',
    scannedAt: (scanRow && scanRow.scanned_at) || so.timestamp || null,
    totalPoints: null, // not applicable — the Observatory tier has no point-summation concept
    maxPoints: null,
    scanners: Array.isArray(scanRow && scanRow.scanner_results) ? scanRow.scanner_results : [],
    scoreObject: so,
  };
}

// The single dispatch point for re-presenting a persisted `scans` row,
// regardless of which tier produced it. Every caller that previously did
// `deriveScanPresentation(scan.scanner_results, scan.scanned_at)` on a row
// read back from the database should call this instead.
function deriveScanPresentationForRow(scanRow) {
  if (scanRow && scanRow.scoring_version === TRUSTPROFILE_SCORING_VERSION) {
    return presentTrustProfileScan(scanRow);
  }
  // Every other value — the historical 'v1.0' default, the 'legacy-scan-v1'
  // alias, or anything unrecognised — routes to the legacy compatibility
  // engine. An unfamiliar scoring_version is always treated as legacy,
  // never assumed to be Observatory-shaped data it wasn't produced by.
  return deriveScanPresentation(scanRow && scanRow.scanner_results, scanRow && scanRow.scanned_at);
}

// Single canonical risk-band vocabulary — re-exported, never re-implemented.
const getRiskLevel = legacyEngine.getRiskLevel;
const getRiskBand = legacyEngine.getRiskBand;

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
  deriveScanPresentationForRow,
  presentTrustProfileScan,
  getRiskLevel,
  getRiskBand,
  resolveRiskLevel,
  deriveRating999,
  deriveRating999Label,
  TRUSTPROFILE_SCORING_VERSION,
  LEGACY_SCORING_VERSION,
};
