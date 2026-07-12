'use strict';

// public-trust.js — the redacted Public Trust view (ENG-008 §9, ENG-017 §4,
// UX-011 §5/§6). ENG-008 §9 is the canonical authority for Public vs.
// Authenticated information visibility; this module is that redaction applied
// at the response-shaping layer — not a second derivation, not a new
// Organisation assembler. It reads the same canonical Organisation object
// `assembleById`/`assembleFromDiscovery` already produce (the same one
// `trustView()` reads for the authenticated Renewal/Trust Profile surfaces)
// and returns strictly less, never different or independently computed data.
//
// Redacted (per ENG-008 §9's Public row): full Organisation History
// (`organisation.history`), per-signal raw detail (`categories[].signals`,
// each carrying a raw score/key/collectedAt), benchmark percentile (never
// computed here to begin with), and the provenance manifest
// (`organisation.provenance`). Kept: headline score, band, a small fixed
// per-category grade — never a bare number, always alongside that band, per
// UX-000 §10's "never a measure without context" (the band is the "standard"
// context this view supplies; peer/history context is deliberately absent —
// see UX-011 §6's recorded resolution of that principle).

const { letterGrade } = require('../adapters/observatory');

/**
 * @param {import('../schema').Organisation} organisation
 */
function publicTrustView(organisation) {
  const domain = organisation.domains && organisation.domains[0] ? organisation.domains[0].domain : null;
  const dt = organisation.digitalTrust;

  return {
    id: organisation.id,
    domain,
    displayName: organisation.displayName,
    digitalTrust: dt
      ? {
        overallScore: dt.overallScore,
        grade: dt.grade,
        signalsObserved: dt.signalsObserved,
        signalsTotal: dt.signalsTotal,
        // A small, fixed, non-sensitive flag per category (name + category-level
        // grade only) — never the per-signal `signals[]` array (raw scores,
        // collection timestamps) `categories[]` carries in the authenticated view.
        categories: (dt.categories || []).map((c) => ({
          category: c.category,
          grade: letterGrade(c.averageScore),
        })),
      }
      : null, // null is a valid, honest answer (Unknown ≠ Absent) — never fabricated
  };
}

module.exports = { publicTrustView };
