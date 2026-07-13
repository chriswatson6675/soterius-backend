'use strict';

// recommendation-derivation.js — Recommendation Derivation, ADR-SYS-012
// (RD-1…RD-8), draft ENG-044 specification. A small pure function over one
// Trust Profile Instance's componentBreakdown/provenanceManifest (already
// computed by generate-trust-profile.js) — same pattern as
// change-indicator.js and projections.js: no I/O, no scoring, no second
// evidence pipeline (RD-3). Never reads scans/prospects/legacy-compat.
//
// Governing rule (RD-3): all scoring authority remains with the canonical
// Aggregator (ENG-026) and the Quality Models it composes. This module only
// ever performs arithmetic over already-computed `earned`/`weight` — never
// a re-scoring pass, never a second independently-declared threshold ladder
// (the exact defect ADR-SYS-011 §7 found and closed once already,
// pre-empted here rather than repeated).

const crypto = require('crypto');

const DERIVATION_VERSION = 'REC-DERIVE-v1.0';

// Reasoned default (ADR-SYS-012 explicitly defers exact thresholds to this
// specification) — quartile-aligned, matching the four-tier vocabulary
// already used elsewhere in this platform (RiskBadge). Flagged, not
// asserted as uniquely correct; changing these requires a DERIVATION_VERSION
// bump (RD-8), never a silent change under the same version string.
const SEVERITY_BANDS = [
  { min: 0.75, severity: 'Critical' },
  { min: 0.50, severity: 'High' },
  { min: 0.25, severity: 'Moderate' },
  { min: 0, severity: 'Low' },
];

function severityFor(gapRatio) {
  for (const band of SEVERITY_BANDS) {
    if (gapRatio >= band.min) return band.severity;
  }
  return 'Low';
}

const SEVERITY_ORDER = { Critical: 0, High: 1, Moderate: 2, Low: 3 };

// Finds the provenanceManifest signal record for one componentBreakdown
// entry — the exact key/qualityModelVersion/collectedAt/sourceRowRef RD-2
// requires every Recommendation to cite. Searches every domain (not just
// organisationDomains[0]) so this stays correct if multi-domain scoring is
// ever authorised — today there is only ever one.
function findSignalProvenance(provenanceManifest, componentId) {
  for (const domain of provenanceManifest?.domains || []) {
    const match = (domain.signals || []).find((s) => s.key === componentId);
    if (match) {
      return {
        signalKey: match.key,
        qualityModelVersion: match.qualityModelVersion,
        collectedAt: match.collectedAt,
        sourceRowRef: match.sourceRowRef,
      };
    }
  }
  return null;
}

// Deterministic, reproducible id (RD-7) — a hash of already-present instance
// facts (organisationId/generatedAt/componentId), never a fact from outside
// the instance (RD-1).
function recommendationId(organisationId, generatedAt, componentId) {
  return crypto
    .createHash('sha256')
    .update(`${organisationId}|${generatedAt}|${componentId}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * deriveRecommendations(trustProfileInstance) → {
 *   organisationId, trustProfileGeneratedAt, derivationVersion, recommendations
 * }
 *
 * Pure function of one Trust Profile Instance (ENG-023 §6). A
 * componentBreakdown entry becomes a candidate Recommendation only when
 * `observed: true` AND `earned < weight` — a real, scored shortfall against
 * a signal that was actually measured (ADR-SYS-012 §6). An `observed: false`
 * entry produces no Recommendation at all (RD-5 — Unknown must never
 * generate a misleading recommendation); an entry with no traceable
 * provenance is skipped rather than presented with fabricated/partial
 * provenance (RD-2).
 */
function deriveRecommendations(trustProfileInstance) {
  const { organisationId, generatedAt, componentBreakdown, provenanceManifest } = trustProfileInstance;

  const candidates = [];
  for (const c of componentBreakdown || []) {
    if (!c.observed) continue;
    if (c.earned >= c.weight) continue;

    const provenance = findSignalProvenance(provenanceManifest, c.id);
    if (!provenance) continue;

    const gapPoints = c.weight - c.earned;
    const gapRatio = c.weight > 0 ? gapPoints / c.weight : 0;

    candidates.push({
      id: recommendationId(organisationId, generatedAt, c.id),
      componentId: c.id,
      category: c.category,
      status: 'gap',
      earned: c.earned,
      weight: c.weight,
      gapPoints,
      gapRatio: Math.round(gapRatio * 10000) / 10000,
      severity: severityFor(gapRatio),
      provenance,
    });
  }

  // Priority ranking (RD-7 — deterministic, strict total order): descending
  // gapPoints (the absolute points recoverable — already incorporates both
  // weight and severity, no new calibration), then severity band, then
  // category letter, then componentId — never array insertion order.
  candidates.sort((a, b) => {
    if (b.gapPoints !== a.gapPoints) return b.gapPoints - a.gapPoints;
    if (SEVERITY_ORDER[a.severity] !== SEVERITY_ORDER[b.severity]) {
      return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    }
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0;
  });

  candidates.forEach((c, i) => { c.priority = i + 1; });

  return {
    organisationId,
    trustProfileGeneratedAt: generatedAt,
    derivationVersion: DERIVATION_VERSION,
    recommendations: candidates,
  };
}

module.exports = { deriveRecommendations, DERIVATION_VERSION };
