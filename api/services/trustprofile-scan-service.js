'use strict';

// trustprofile-scan-service.js — the canonical live-scan orchestrator for
// POST /api/scan (ADR-SYS-011, Legacy Scanner Retirement).
//
// Runs the SAME on-demand Observatory pipeline already used in production by
// POST /api/public-scan (api/routes/public-scan.js) and, on the read side,
// GET /api/organisation/:id (organisation/adapters/observatory.js) — no new
// collection, resolution, or scoring logic is introduced here. This module's
// only job is composing those two canonical, unmodified calls
// (runOnDemandObservation + observatory.getObservatoryProfile) into the
// response contract POST /api/scan has always returned, and mapping the
// Observatory's overallScore onto the SAME risk-band vocabulary the legacy
// engine used (getRiskBand, imported and reused via scan-derivation-service
// — never re-implemented), so existing clients keep receiving a `riskLevel`
// value from the familiar 5-tier vocabulary (Excellent/Good/Moderate
// Risk/High Risk/Critical Risk).
//
// This is the ONLY module POST /api/scan calls to produce a fresh score.
// It never imports backend/api/legacy-compat/* — that module exists solely
// to re-present historical rows, not to score new ones.

const { runOnDemandObservation } = require('../../observatory/on-demand/on-demand-observation');
const observatory = require('../../organisation/adapters/observatory');
const { getRiskBand, TRUSTPROFILE_SCORING_VERSION } = require('./scan-derivation-service');

// Reuses the SAME canonical risk-band thresholds as the check-level status
// classification below, rather than inventing a second, independently
// declared cutoff scheme.
function statusFromScore(score) {
  if (typeof score !== 'number') return 'FAIL';
  const band = getRiskBand(score);
  if (band === 'Excellent' || band === 'Good') return 'PASS';
  if (band === 'Moderate Risk') return 'WARNING';
  return 'FAIL';
}

// Observatory's per-category rollup (observatory.js summarize()) -> the same
// { name, score, rating, checks } scanner shape the legacy tier's response
// contract already used, so downstream consumers (submit-gate's scanDetails
// mapping, adaptScannersForPDF) keep working against a familiar array shape
// even though the category names themselves are now Observatory's (Email
// Trust / Domain Trust / Certificate & TLS Trust / Disclosure) rather than
// the legacy five (ssl/email/headers/vulnComp/gdpr) — deliberately NOT
// force-mapped onto the old category names, which would misrepresent what
// was actually measured (see ADR-SYS-011 §"Compatibility strategy").
function toScannersShape(categories) {
  return (categories || []).map((cat) => ({
    name: cat.category,
    score: cat.averageScore,
    rating: getRiskBand(cat.averageScore),
    checks: (cat.signals || []).map((s) => ({
      name: s.key,
      status: statusFromScore(s.score),
      details: s.label || null,
      timeToFix: 'N/A',
    })),
  }));
}

/**
 * Run the canonical Observatory pipeline for one domain and shape the result
 * into POST /api/scan's existing response contract.
 * @param {string} domain
 * @param {object} [deps] - injectable for tests: { runOnDemandObservationFn, getObservatoryProfileFn, now }
 * @returns {Promise<{score:number, riskLevel:string, scannedAt:string, totalPoints:null, maxPoints:null, scanners:Array, scoreObject:object}>}
 */
async function executeTrustProfileScan(domain, deps = {}) {
  const {
    runOnDemandObservationFn = runOnDemandObservation,
    getObservatoryProfileFn = observatory.getObservatoryProfile,
    now = () => new Date().toISOString(),
  } = deps;

  const scannedAt = now();
  const observation = await runOnDemandObservationFn(domain);

  if (!observation.ok) {
    // The pipeline failed to even open a session — there is no partial
    // Observatory result to present. Surface an honestly-empty presentation
    // rather than throwing, mirroring the legacy engine's own per-scanner
    // failure isolation (a failed collector produces a FAIL check, never an
    // unhandled exception that would 500 the whole request).
    return emptyPresentation(scannedAt, observation.error);
  }

  const profile = await getObservatoryProfileFn(domain);
  const overallScore = profile.ok ? profile.overallScore : null;
  const riskLevel = overallScore == null ? 'Critical Risk' : getRiskBand(overallScore);
  const categories = (profile.ok && profile.categories) || [];
  const scanners = toScannersShape(categories);

  const scoreObject = {
    overallScore,
    grade: profile.ok ? profile.grade : null,
    riskBand: riskLevel,
    signalsObserved: profile.ok ? profile.signalsObserved : 0,
    signalsTotal: profile.ok ? profile.signalsTotal : 0,
    categories,
    timestamp: scannedAt,
    scoringVersion: TRUSTPROFILE_SCORING_VERSION,
    sessionId: observation.sessionId,
    resolutionOutcome: observation.resolutionOutcome,
  };

  return {
    score: overallScore ?? 0,
    riskLevel,
    scannedAt,
    totalPoints: null,
    maxPoints: null,
    scanners,
    scoreObject,
  };
}

function emptyPresentation(scannedAt, error) {
  const scoreObject = {
    overallScore: null,
    grade: null,
    riskBand: 'Critical Risk',
    signalsObserved: 0,
    signalsTotal: 0,
    categories: [],
    timestamp: scannedAt,
    scoringVersion: TRUSTPROFILE_SCORING_VERSION,
    pipelineError: error || 'observation pipeline failed to start',
  };
  return {
    score: 0,
    riskLevel: 'Critical Risk',
    scannedAt,
    totalPoints: null,
    maxPoints: null,
    scanners: [],
    scoreObject,
  };
}

module.exports = { executeTrustProfileScan };
