'use strict';

// profile.js — the Organisation Profile view (ADR-SYS-010 §2.2: "an Experience
// may compute a product-specific view... but that computation happens on
// read"). Feeds Renewal's Practice Information screen; reusable by any future
// Experience that needs identity/legal/regulatory facts, unchanged.

/**
 * @param {import('../schema').Organisation} organisation
 */
function profileView(organisation) {
  return {
    id: organisation.id,
    displayName: organisation.displayName,
    identifiers: organisation.identifiers,
    legalEntities: organisation.legalEntities,
    domains: organisation.domains,
    regulators: organisation.regulators,
    provenance: organisation.provenance.filter((p) => p.section !== 'digitalTrust'),
  };
}

module.exports = { profileView };
