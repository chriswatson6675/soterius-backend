'use strict';

// classification.js — Organisation classification, per the Organisation
// Discovery review §3 and §7 (Priority 3 full design). Modelled exactly like
// an Observation: append-only, timestamped, provenance-bearing — not a
// single mutable field. Phase A has no persistence, so in practice this
// always returns a single-generation history (observedAt = collectedAt =
// now, supersededBy = null) — the correct SHAPE now, so Phase B's persisted
// classification_observations table requires no rework, only storage.
//
// Provider-agnostic: takes raw (scheme, code, source) facts, not a
// Companies-House-specific input. A future NAICS-supplying provider is a new
// caller of this same function, not a change to it.

/**
 * @param {Array<{scheme: string, code: string, source: string, observedAt: string}>} rawFacts
 * @returns {Array<{scheme: string, code: string, label: string|null, source: string, confidence: 'verified', observedAt: string, collectedAt: string, supersededBy: null}>}
 */
function deriveClassification(rawFacts) {
  const now = new Date().toISOString();
  return rawFacts.map((f) => ({
    scheme: f.scheme,
    code: f.code,
    // No label fabricated — Companies House's profile endpoint returns SIC
    // codes only, no descriptions. A code with no label is an honest Unknown,
    // not a gap to paper over (OC-4). Cross-scheme label normalisation is
    // explicitly out of scope (see the classification design review).
    label: f.label || null,
    source: f.source,
    confidence: 'verified',
    observedAt: f.observedAt,
    collectedAt: now,
    supersededBy: null,
  }));
}

/** Companies House SIC codes -> raw classification facts. One call site per provider. */
function fromCompaniesHouse(sicCodes, observedAt) {
  return (sicCodes || []).map((code) => ({ scheme: 'uk-sic-2007', code, source: 'companies-house', observedAt }));
}

module.exports = { deriveClassification, fromCompaniesHouse };
