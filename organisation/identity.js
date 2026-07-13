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
// Precedence (originally: Companies House number → FCA FRN → SRA number →
// UKPRN → IF-UUID → normalised-name + domain hash — a lossless extraction
// from the original build.js:118, not a redesign). Extended per GCN-004
// (Identity-Namespace Extension & Key-Precedence Disposition, Founder-
// registered 2026-07-07): Companies House number → FCA FRN → SRA number →
// FRC audit-firm registration number → HMRC AML registration number →
// permissioned-PBS firm id → UKPRN → IF-UUID → LEI → normalised-name +
// domain hash. This is implementation of an already-ratified governance
// disposition (GCN-004 §E.2, §F), not a new identity design: the three new
// register-identifier members (`frcAudit`, `hmrcAml`, `pbsFirm`) are soft
// strong-identifiers inserted between SRA number and UKPRN exactly where
// GCN-004 §F's namespace-delta table places them, and LEI moves from
// "collected but not unioned" to a precedence member at the tail (GCN-004
// §E.5's union-consistency fix), immediately above the keyless fallback.
// UKPRN and IF-UUID keep their established positions unchanged (GCN-004
// §E.2: "retained... outside the accountancy precedence"). No identifier
// already in the chain is removed, renamed, or reordered relative to the
// others already present — the extension is additive and insertive only,
// per GCN-004 §F ("no existing identifier is removed, renamed, or
// reordered"). Callers that never populate the four new fields (every
// caller as of this change — see identity.test.js's OC-6 tests) see no
// behavioural difference: an absent/falsy field is skipped exactly as
// today, so no existing `ORG-<sha1>` id changes as a result of this edit
// (GCN-004 §H: "preserve all existing organisation IDs unchanged").
//
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
 * @param {string|null} [identifiers.frcAudit]        - FRC audit-firm registration number (GCN-004 §E.1)
 * @param {string|null} [identifiers.hmrcAml]         - HMRC AML supervised-business registration number (GCN-004 §E.1)
 * @param {string|null} [identifiers.pbsFirm]         - permissioned-PBS firm id (GCN-004 §E.1)
 * @param {string|null} [identifiers.ukprn]
 * @param {string|null} [identifiers.ifUuid]          - strongest IF-UUID, pre-sorted by the caller if several
 * @param {string|null} [identifiers.lei]              - Legal Entity Identifier (GCN-004 §E.5 — union-consistency tail member)
 * @param {string|null} [identifiers.normalisedName]  - caller resolves any name-fallback chain before calling
 * @param {string|null} [identifiers.domain]
 * @returns {string} the primary key string (not yet hashed)
 */
function primaryKeyOf(identifiers) {
  if (identifiers.companiesHouseNumber) return `cn:${identifiers.companiesHouseNumber}`;
  if (identifiers.frn) return `frn:${identifiers.frn}`;
  if (identifiers.sraNumber) return `sra:${identifiers.sraNumber}`;
  if (identifiers.frcAudit) return `frcAudit:${identifiers.frcAudit}`;
  if (identifiers.hmrcAml) return `hmrcAml:${identifiers.hmrcAml}`;
  if (identifiers.pbsFirm) return `pbsFirm:${identifiers.pbsFirm}`;
  if (identifiers.ukprn) return `ukprn:${identifiers.ukprn}`;
  if (identifiers.ifUuid) return `uuid:${identifiers.ifUuid}`;
  if (identifiers.lei) return `lei:${identifiers.lei}`;
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
