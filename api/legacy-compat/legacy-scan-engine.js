const sslCheck       = require('../legacy-scanner/ssl-check');
const headersCheck   = require('../legacy-scanner/headers-check');
const emailSecurity  = require('../legacy-scanner/dns-check');
const vulnComponents = require('../legacy-scanner/tech-detect');
const gdprCheck      = require('../legacy-scanner/gdpr-check');
const logger         = require('../../infra/utils/logger');

// v1.0 methodology — do not modify without incrementing scoringVersion and
// updating SCORING.md + DECISIONS.md.
const SCANNERS = [
  { key: 'ssl',      name: 'SSL/TLS Encryption',      fn: sslCheck,       maxPoints: 40,  pts: { PASS: 10, WARNING:  5, FAIL: 0 } },
  { key: 'email',    name: 'Email Security',           fn: emailSecurity,  maxPoints: 56,  pts: { PASS:  8, WARNING:  4, FAIL: 0 } },
  { key: 'headers',  name: 'Security Headers',         fn: headersCheck,   maxPoints: 50,  pts: null },
  { key: 'vulnComp', name: 'Vulnerable Components',    fn: vulnComponents, maxPoints: 48,  pts: { PASS:  4, WARNING:  2, FAIL: 0 } },
  { key: 'gdpr',     name: 'GDPR / Cookie Compliance', fn: gdprCheck,      maxPoints: 12,  pts: { PASS:  2, WARNING:  1, FAIL: 0 } },
];

// ssl(40) + email(56) + headers(50) + vulnComp(48) + gdpr(12) = 206
const MAX_POINTS = SCANNERS.reduce((sum, def) => sum + def.maxPoints, 0);

function getRiskLevel(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Moderate Risk';
  if (score >= 40) return 'High Risk';
  return 'Critical Risk';
}

function getRiskBand(pct) {
  if (pct >= 90) return 'Excellent';
  if (pct >= 75) return 'Good';
  if (pct >= 60) return 'Moderate Risk';
  if (pct >= 40) return 'High Risk';
  return 'Critical Risk';
}

// Runs the 5 legacy collectors and returns raw, unscored check results only —
// one entry per SCANNERS def, in order. No scoring, no interpretation happens
// here (ADR-SYS-008 / OBS-CONST-001 P-2: a collector observes, it does not
// score). This is the function a future Observation-persistence step (ADR-SYS-009
// Phase 2) writes from, independent of deriveTrustScore below.
async function collect(domain) {
  logger.info(`Scan started for ${domain}`);

  const raw = await Promise.allSettled(SCANNERS.map(s => s.fn(domain)));

  return SCANNERS.map((def, i) => {
    const checks = raw[i].status === 'fulfilled'
      ? raw[i].value
      : [{ name: 'Scanner error', status: 'FAIL', details: raw[i].reason?.message || 'Unknown error', timeToFix: 'N/A' }];
    return { key: def.key, name: def.name, checks };
  });
}

// Pure function: raw per-scanner check results -> score/riskBand/scoreObject.
// Contains ALL scoring logic for the legacy scan tier — this is the ADR-SYS-008
// "derivation" (score/risk band are computed, not preserved evidence). Isolating
// it here, independent of collect(), is what lets a future derivation service
// call it without re-running collection.
//
// v1.0 methodology — do not modify without incrementing scoringVersion and
// updating SCORING.md + DECISIONS.md.
function deriveTrustScore(scannerResults, scannedAt = new Date().toISOString()) {
  const interim = SCANNERS.map((def) => {
    const result = scannerResults.find(r => r.key === def.key);
    const checks = result
      ? result.checks
      : [{ name: 'Scanner error', status: 'FAIL', details: 'Missing scanner result', timeToFix: 'N/A' }];

    const earnedPts = checks.reduce((sum, c) => {
      if (typeof c.points === 'number') return sum + c.points;
      const status = String(c.status || '').toUpperCase();
      return sum + (def.pts ? (def.pts[status] ?? 0) : 0);
    }, 0);

    return { def, checks, maxPts: def.maxPoints, earnedPts };
  });

  const totalPoints = interim.reduce((sum, r) => sum + r.earnedPts, 0);
  const score       = Math.round((totalPoints / MAX_POINTS) * 100);
  const riskLevel   = getRiskLevel(score);

  const categoryBreakdown = {};
  const scanners = interim.map(({ def, checks, maxPts, earnedPts }) => {
    const catPct    = maxPts > 0 ? Math.round((earnedPts / maxPts) * 100) : 0;
    const catRating = getRiskBand(catPct);
    categoryBreakdown[def.key] = { achieved: earnedPts, maximum: maxPts, percentage: catPct, rating: catRating };
    return { name: def.name, score: catPct, rating: catRating, checks };
  });

  const scoreObject = {
    achievedPoints: totalPoints,
    totalMaximum:   MAX_POINTS,
    percentage:     score,
    riskBand:       riskLevel,
    categoryBreakdown,
    timestamp:      scannedAt,
    scoringVersion: 'v1.0',
  };

  return { score, riskLevel, scannedAt, totalPoints, maxPoints: MAX_POINTS, scanners, scoreObject };
}

// Runs all 5 scanners against a domain and returns a complete scan result.
// Does NOT persist to the database — callers are responsible for calling saveScan.
// Unchanged output shape — this is collect() + the canonical derivation service
// composed, not a new methodology. Score/risk-band generation for a live scan
// goes through scan-derivation-service.js (ADR-SYS-008 Phase A), which wraps
// deriveTrustScore below rather than duplicating it.
async function executeScan(domain) {
  const scannerResults = await collect(domain);
  const derived = require('./scan-derivation-service').deriveScanPresentation(scannerResults);

  logger.info(`Scan complete for ${domain} — score: ${derived.score} (${derived.riskLevel})`);

  return derived;
}

module.exports = { executeScan, collect, deriveTrustScore, getRiskLevel, getRiskBand, SCANNERS, MAX_POINTS };
