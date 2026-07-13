'use strict';

/*
 * Trust Score engine — TS-RUBRIC-v1.0+TSW-METH-v1.0
 * ==================================================
 *
 * Thin, contract-preserving wrapper over the Canonical Trust Score
 * Aggregator (ENG-026, backend/observatory/aggregation/trust-score-
 * aggregator.js). Per ENG-026 §11.2, this module's raw-fact re-scoring
 * functions (scoreSpf/scoreDmarc/scoreDkim/scoreDnssec/scoreCaa/
 * scoreSecurityHeaders/scoreMtaSts/scoreSecurityTxt) and hand-set WEIGHTS
 * table are RETIRED — they duplicated the frozen Quality Models
 * (backend/observatory/quality/*-quality.js), which is exactly the
 * architectural defect ENG-026 §13 exists to close. scoreTrust() no longer
 * re-scores from raw collected facts; it consumes each signal's already-
 * calibrated signal_quality_*.final_score via the Aggregator.
 *
 * scoreTrust(domain) signature (async — ENG-026 §11.2's "domain, or an
 * equivalent async form" option) replaces the prior scoreTrust(facts)
 * (synchronous, raw-fact) signature. The RUBRIC export slot, output shape
 * (score/label/band, categories, signals) and provisionalBand() are
 * preserved for existing consumers (baseline.js reads RUBRIC; derive.js
 * calls scoreTrust()).
 *
 * v1 scope is Categories A–D only (SLG-135 §1 excludes E/H — no calibrated
 * Quality Model exists for them yet); categories/signals below cover only
 * the 10 signals with both a frozen QM and persisted signal_quality_* data.
 */

const { computeTrustScore } = require('../aggregation/trust-score-aggregator');

const RUBRIC = 'TS-RUBRIC-v1.0+TSW-METH-v1.0';
const BASE_BUDGET = 999;

// Provisional reporting overlay (SLG-038 §1) — NOT part of the rubric, scaled
// from the legacy model, pending benchmark-layer recalibration. Reported for
// orientation only; never treated as canonical.
function provisionalBand(score, label) {
  if (label === 'INSUFFICIENT_OBSERVATION') return 'Insufficient';
  if (score >= 900) return 'Excellent';
  if (score >= 750) return 'Good';
  if (score >= 600) return 'Moderate';
  if (score >= 400) return 'High';
  return 'Critical';
}

/*
 * scoreTrust(domain, deps = {}) — delegates to computeTrustScore(). `deps`
 * is forwarded unchanged (getSignalsForDomain / weightSet overrides), used
 * by tests to prove determinism (AC-2) without a live DB dependency.
 */
async function scoreTrust(domain, deps = {}) {
  const result = await computeTrustScore(domain, deps);

  const observedSignalCount = result.signals.filter((s) => s.status === 'OBSERVED').length;
  const coreComplete = result.signals.every((s) => s.status === 'OBSERVED');
  const completeness = Number((result.attainable / BASE_BUDGET).toFixed(4));

  return {
    rubric: RUBRIC,
    score: result.score,
    label: result.label,
    band: provisionalBand(result.score, result.label),
    earned: result.earned,
    attainable: result.attainable,
    completeness,
    coreComplete,
    observedSignalCount,
    weightSetId: result.weightSetId,
    methodVersion: result.methodVersion,
    categories: result.categories,
    signals: result.signals,
  };
}

module.exports = { RUBRIC, BASE_BUDGET, scoreTrust, provisionalBand };
