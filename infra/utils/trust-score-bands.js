'use strict';

// trust-score-bands.js — the ONE canonical threshold table for classifying a
// 0-100 trust score into a human-readable presentation label (ADR-SYS-011
// §"Canonical Presentation Model", Scoring Presentation Convergence).
//
// Every place in the repository that turns a score into a risk band, risk
// level, or letter grade — for both the historical legacy-compat tier
// (backend/api/legacy-compat/legacy-scan-engine.js) and the canonical
// Observatory/Trust Profile tier (backend/organisation/adapters/observatory.js,
// backend/api/services/trustprofile-scan-service.js) — derives from this
// single ordered table. Do not declare a second threshold ladder anywhere;
// import and reuse this one.
//
// These are PRESENTATION thresholds (how a score is labelled), not the
// legacy engine's frozen v1.0 SCORING methodology (how a score is computed —
// MAX_POINTS/SCANNERS/point-summation, which this module does not touch).
// This table reuses the exact 90/75/60/40 cutoffs the legacy engine has
// always classified scores with, so no historical `scans` row's derived
// risk band changes as a result of this module's introduction — it is a
// deduplication of existing behaviour, not a threshold change. The one
// score-plane-visible correction is `letterGrade` (observatory.js), which
// previously used a second, independently-declared 90/75/55/35 ladder that
// could disagree with the risk band for the same score (regression audit
// finding C-5) — it now derives its grade from these same cutoffs.

const THRESHOLDS = [
  { min: 90, band: 'Excellent',     grade: 'A' },
  { min: 75, band: 'Good',          grade: 'B' },
  { min: 60, band: 'Moderate Risk', grade: 'C' },
  { min: 40, band: 'High Risk',     grade: 'D' },
  { min: 0,  band: 'Critical Risk', grade: 'E' },
];

// Returns the full threshold-row classification for a score — the single
// place the table is walked. Every exported function below is a thin
// projection of this one lookup, never a second table.
function classify(score) {
  const s = typeof score === 'number' && !Number.isNaN(score) ? score : 0;
  return THRESHOLDS.find((t) => s >= t.min) || THRESHOLDS[THRESHOLDS.length - 1];
}

function getRiskBand(score) {
  return classify(score).band;
}

// Historical alias for getRiskBand. legacy-scan-engine.js previously
// declared getRiskLevel/getRiskBand as two byte-identical function bodies
// under different names (one duplicated ladder, called two ways) — kept as
// two exported names here for backward compatibility with existing call
// sites, now backed by exactly one implementation.
const getRiskLevel = getRiskBand;

function getGrade(score) {
  return classify(score).grade;
}

module.exports = { THRESHOLDS, classify, getRiskBand, getRiskLevel, getGrade };
