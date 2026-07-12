'use strict';

// schema.js — the canonical Organisation contract, per ADR-SYS-010 §2.
//
// Not a validation library or ORM — this is the documented shape every
// assembler/view in this module must produce/consume, kept in one place so
// it can't silently drift between resolve.js, assemble.js, and views/.
//
// Populates: id, displayName, identifiers, legalEntities, domains,
// regulators, digitalTrust, lifecycle, classification, provenance, metadata.
// `people` and `history` are typed placeholders (ADR-SYS-010 §3 disposition)
// — no adapter exists for either yet; do not populate them with guesses.

/**
 * @typedef {Object} Provenance
 * @property {string} section        - which part of the Organisation this covers, e.g. "legalEntities[0]"
 * @property {string} source         - "companies-house" | "sra-snapshot" | "soterius-observatory"
 * @property {string|null} observedAt - when the underlying fact was observed (source's own timestamp)
 * @property {string} retrievedAt    - when this system last pulled it
 * @property {"verified"|"corroborated"|"inferred"} confidence
 */

/**
 * @typedef {Object} Organisation
 * @property {string} id                    - canonical id, e.g. "ORG-3F9A2C1E7B4D" (organisation/identity.js)
 * @property {string|null} displayName
 * @property {Array<{scheme: string, value: string, primary?: boolean}>} identifiers
 * @property {Array<Object>} legalEntities
 * @property {Array<{domain: string, role: string}>} domains
 * @property {Array<{regulator: string, identifier: string, status: string|null}>} regulators
 * @property {Object|null} digitalTrust      - shape unchanged from organisation/adapters/observatory.js's getObservatoryProfile
 * @property {{milestones: string[], status: string, supersededBy: string|null}} lifecycle - derived, see lifecycle.js
 * @property {Array<Object>} classification  - append-only, timestamped; see classification.js
 * @property {Array<Object>} people          - v0.1: always []
 * @property {Array<Object>} history         - v0.1: always []
 * @property {Provenance[]} provenance
 * @property {Object} metadata
 */

/** Empty-but-shaped Organisation — every assembler starts from this so no field is ever silently missing. */
function emptyOrganisation(id) {
  return {
    id,
    displayName: null,
    identifiers: [],
    legalEntities: [],
    domains: [],
    regulators: [],
    digitalTrust: null,
    lifecycle: { milestones: [], status: 'active', supersededBy: null },
    classification: [],
    people: [],
    history: [],
    provenance: [],
    metadata: {
      resolvedAt: new Date().toISOString(),
      sourcesConsulted: [],
      sourcesUnavailable: [],
    },
  };
}

module.exports = { emptyOrganisation };
