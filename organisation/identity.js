'use strict';

// identity.js — canonical Organisation identity, per ADR-SYS-010 OC-6.
//
// OC-6: "Any process that resolves or creates a canonical identity — batch or
// live — MUST use the same deterministic identifier precedence, so the same
// real-world organisation always resolves to the same id."
//
// This is now the ONLY implementation of that precedence in the repository.
// backend/authority/build.js (batch) and backend/organisation/resolve.js
// (live) both import and call this module rather than each defining their
// own copy — the duplication ADR-SYS-010 OC-6 flagged as a compliance risk
// in the Renewal Experience v0.1 report is closed by this file existing as
// the single source of truth, not by keeping two hand-synced copies in sync.
//
// Precedence (unchanged from the original build.js:118 primaryKeyOf — this
// is a lossless extraction, not a redesign): Companies House number → FCA
// FRN → SRA number → UKPRN → IF-UUID → normalised-name + domain hash.
// Collision-suffix resolution (`ORG-xxx`, `ORG-xxx-2`, ...) stays batch-only
// in build.js — it requires seeing every organisation in one run to order
// deterministically, which no live, per-request resolution can do. That is
// a property of *assigning ids across a set*, not of the precedence itself,
// so it correctly stays outside this module.

const crypto = require('crypto');

function sha(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

/**
 * @param {Object} identifiers
 * @param {string|null} [identifiers.companiesHouseNumber]
 * @param {string|null} [identifiers.frn]            - FCA Firm Reference Number
 * @param {string|null} [identifiers.sraNumber]
 * @param {string|null} [identifiers.ukprn]
 * @param {string|null} [identifiers.ifUuid]          - strongest IF-UUID, pre-sorted by the caller if several
 * @param {string|null} [identifiers.normalisedName]  - caller resolves any name-fallback chain before calling
 * @param {string|null} [identifiers.domain]
 * @returns {string} the primary key string (not yet hashed)
 */
function primaryKeyOf(identifiers) {
  if (identifiers.companiesHouseNumber) return `cn:${identifiers.companiesHouseNumber}`;
  if (identifiers.frn) return `frn:${identifiers.frn}`;
  if (identifiers.sraNumber) return `sra:${identifiers.sraNumber}`;
  if (identifiers.ukprn) return `ukprn:${identifiers.ukprn}`;
  if (identifiers.ifUuid) return `uuid:${identifiers.ifUuid}`;
  return `nd:${sha((identifiers.normalisedName || '') + '|' + (identifiers.domain || ''))}`;
}

/**
 * @param {object} identifiers - see primaryKeyOf
 * @returns {string} e.g. "ORG-3F9A2C1E7B4D"
 */
function canonicalOrgId(identifiers) {
  const pk = primaryKeyOf(identifiers);
  return `ORG-${sha(pk).slice(0, 12).toUpperCase()}`;
}

module.exports = { canonicalOrgId, primaryKeyOf, sha };
