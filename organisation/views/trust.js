'use strict';

// trust.js — the Organisation Trust view. Feeds Renewal's Digital Trust
// screen; identical data Trust Profile and Benchmarking will read later —
// this is the concrete case ADR-SYS-010 §2.2 exists to enable: one fact,
// rendered by multiple Experiences, computed here once.

/**
 * @param {import('../schema').Organisation} organisation
 */
function trustView(organisation) {
  const domain = organisation.domains[0] ? organisation.domains[0].domain : null;
  return {
    id: organisation.id,
    domain,
    digitalTrust: organisation.digitalTrust, // null is a valid, honest answer (OC-4) — not "no trust", "not yet observed"
    provenance: organisation.provenance.filter((p) => p.section === 'digitalTrust'),
  };
}

module.exports = { trustView };
