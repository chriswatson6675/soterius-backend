'use strict';

// resolve.js — identity resolution over Repository Authority, per ADR-SYS-010
// OC-6 and the Organisation Discovery review (Priorities 1 & 3).
//
// Priority 1: the index is built from backend/authority/dataset/organisations.ndjson
// — Repository Authority's own merged, deduplicated, already-id-assigned output
// — not from a raw SRA snapshot. organisations.ndjson already subsumes SRA data
// (SRA is one of build.js's merged sources), so this is a REPLACEMENT of the
// prior SRA-only index, not an addition alongside it: indexing the raw SRA
// snapshot once the merged output exists would just re-derive what Repository
// Authority already did correctly. This closes a real correctness gap that
// predates and is independent of Organisation Discovery — an organisation
// known only via Companies House or FCA (most of the batch dataset) was
// previously unreachable through this module at all.
//
// Priority 3: resolveIdentity() accepts a bag of optional identifiers (name,
// domain, and any provider's identifier scheme) and returns a found-or-new
// outcome, or an explicit conflict — see the discovery review's Option A
// decision. This is resolution generalised to multi-valued input, not a
// separate discovery service; there is no discover.js.
//
// Still no persisted Identity Store (Phase A, unchanged) — this index is a
// derived, disposable artefact rebuilt from disk on process start, exactly
// as the prior SRA-only version was.

const fs = require('fs');
const path = require('path');
const readline = require('node:readline');

const { canonicalOrgId } = require('./identity');
const providers = require('./providers');
const N = require('../authority/lib/normalise');

// build.js normalises every field before it ever reaches primaryKeyOf (see
// authority/lib/normalise.js's own header: "the single source of truth for
// how identity strings are compared across every legacy registry"). The live
// path must apply the exact same normalisation before calling identity.js,
// or two representations of the same real organisation ("Saltus Partners
// LLP" vs however Repository Authority's own pipeline normalised it) compute
// different ids and silently fail to converge — found empirically while
// verifying this implementation, not designed in from the start. identity.js
// itself is untouched: this fixes what's fed to it, not the precedence.
function normaliseFacts(facts) {
  return {
    companiesHouseNumber: N.normaliseCompanyNumber(facts.companiesHouseNumber),
    sraNumber: N.normaliseNumericId(facts.sraNumber),
    frn: N.normaliseNumericId(facts.frn),
    normalisedName: N.normaliseName(facts.normalisedName || facts.name),
    domain: N.normaliseDomain(facts.domain),
  };
}

const DEFAULT_DATASET_PATH = path.join(__dirname, '..', 'authority', 'dataset', 'organisations.ndjson');
const DEFAULT_DOMAINS_PATH = path.join(__dirname, '..', 'authority', 'dataset', 'domains.ndjson');

let authority = null; // { byId, byIdentifier, byDomain, rows, loadedAt, authorityVersion, error }

function datasetPath() {
  return process.env.ORGANISATION_DATASET_PATH || DEFAULT_DATASET_PATH;
}

function domainsDatasetPath() {
  return process.env.AUTHORITY_DOMAINS_PATH || DEFAULT_DOMAINS_PATH;
}

// Clear the in-memory index so the next resolution re-reads Repository Authority
// from disk. This is how "a Repository Authority change immediately affects future
// resolution" is realised: rebuild the dataset (authority/build.js) then reload().
// The index is a derived, disposable artefact (see module header) — never a
// second source of truth.
function reload() {
  authority = null;
  return loadAuthority();
}

function loadAuthority() {
  if (authority) return authority;

  const p = datasetPath();
  if (!fs.existsSync(p)) {
    authority = { byId: new Map(), byIdentifier: new Map(), byDomain: new Map(), rows: [], loadedAt: null, authorityVersion: null, error: `No Repository Authority dataset found at ${p} — run node backend/authority/build.js` };
    return authority;
  }

  const byId = new Map();
  const byIdentifier = new Map();
  const byDomain = new Map();
  const rows = [];

  const raw = fs.readFileSync(p, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    rows.push(row);
    byId.set(row.organisationId, row);

    const ids = row.identifiers || {};
    if (ids.companiesHouseNumber) byIdentifier.set(`uk.companieshouse.number:${N.normaliseCompanyNumber(ids.companiesHouseNumber)}`, row.organisationId);
    if (ids.sraIdentifier) byIdentifier.set(`uk.sra.number:${N.normaliseNumericId(ids.sraIdentifier)}`, row.organisationId);
    if (ids.frn) byIdentifier.set(`uk.fca.frn:${N.normaliseNumericId(ids.frn)}`, row.organisationId);
  }

  // Domain → Organisation index, read from Repository Authority's own
  // domains.ndjson (build.js output). Each row already reflects every applied
  // merge, acquisition, and approved remediation — the resolver reuses that
  // exactly and never re-derives it. domains not in this file are simply not
  // resolvable (NOT_FOUND), never guessed.
  const dp = domainsDatasetPath();
  if (fs.existsSync(dp)) {
    const rawD = fs.readFileSync(dp, 'utf8');
    for (const line of rawD.split('\n')) {
      if (!line.trim()) continue;
      const d = JSON.parse(line);
      const key = N.normaliseDomain(d.domain);
      if (key) byDomain.set(key, d);
    }
  }

  const loadedAt = fs.statSync(p).mtime.toISOString();
  authority = { byId, byIdentifier, byDomain, rows, loadedAt, authorityVersion: loadedAt, error: null };
  return authority;
}

function domainFromWebsite(website) {
  if (!website) return null;
  try {
    const u = new URL(website.startsWith('http') ? website : `https://${website}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * @param {string} query - firm name, or a digit identifier (SRA/CH/FRN)
 */
function search(query, { limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, results: [] };
  const { byIdentifier, byId, rows, error } = loadAuthority();
  if (error) return { ok: false, error };

  if (/^\d+$/.test(q)) {
    const sraId = byIdentifier.get(`uk.sra.number:${N.normaliseNumericId(q)}`);
    if (sraId) return { ok: true, results: [toCandidate(byId.get(sraId))] };
    const frnId = byIdentifier.get(`uk.fca.frn:${N.normaliseNumericId(q)}`);
    if (frnId) return { ok: true, results: [toCandidate(byId.get(frnId))] };
    const chId = byIdentifier.get(`uk.companieshouse.number:${N.normaliseCompanyNumber(q)}`);
    if (chId) return { ok: true, results: [toCandidate(byId.get(chId))] };
  }

  const needle = q.toLowerCase();
  const results = [];
  for (const row of rows) {
    const name = (row.organisationName || row.canonicalName || '').toLowerCase();
    if (name.includes(needle)) {
      results.push(toCandidate(row));
      if (results.length >= limit) break;
    }
  }
  return { ok: true, results };
}

function toCandidate(row) {
  const ids = row.identifiers || {};
  return {
    id: row.organisationId,
    name: row.organisationName || row.canonicalName,
    domain: row.verifiedDomain || null,
    regulator: Array.isArray(row.regulators) && row.regulators.length > 0 ? row.regulators[0] : null,
    sraNumber: ids.sraIdentifier || null,
    companiesHouseNumber: ids.companiesHouseNumber || null,
    frn: ids.frn || null,
    town: null, // Repository Authority's merged rows don't carry office/address detail — honestly null, not fabricated (OC-4)
  };
}

/**
 * The first organisation id in Repository Authority. Deterministic (build.js
 * emits organisations.ndjson in a stable order) and read-only over the same
 * in-memory index every other resolver uses — it is NOT a new source of truth.
 * Intended for dev tooling that needs any real canonical organisation to point
 * at (bootstrap-dev.js), never for product resolution. Returns an explicit
 * error, never a fabricated id, when Repository Authority has not been built.
 * @returns {{ok: true, organisationId: string} | {ok: false, error: string}}
 */
function firstOrganisationId() {
  const { rows, error } = loadAuthority();
  if (error) return { ok: false, error };
  if (!rows.length) return { ok: false, error: 'Repository Authority dataset is empty — run node backend/authority/build.js' };
  return { ok: true, organisationId: rows[0].organisationId };
}

/**
 * Resolve a canonical id back to its Repository Authority row, so assemble.js
 * can branch on whichever identifiers are actually present (Priority 2).
 * @param {string} orgId
 */
function reverse(orgId) {
  const { byId, error } = loadAuthority();
  if (error) return { ok: false, error };
  const row = byId.get(orgId);
  if (!row) return { ok: false, error: `No organisation known for id ${orgId}` };
  return { ok: true, row };
}

/**
 * Priority 3 — multi-identifier resolution. Accepts any combination of
 * identifiers and returns exactly one of: an existing organisation, a newly
 * computed (not-yet-in-Repository-Authority) organisation, or an explicit
 * conflict when supplied identifiers disagree. Never silently picks one
 * (ADR-COL-010 — a conflict is a candidate correction, not an automatic one).
 *
 * @param {{name?: string, domain?: string, companiesHouseNumber?: string, sraNumber?: string, frn?: string, [key: string]: string}} input
 * @returns {{ok: true, organisationId: string, isNew: boolean, unsupported: string[]}
 *          | {ok: false, conflict: true, candidates: object[]}
 *          | {ok: false, error: string}}
 */
function resolveIdentity(input) {
  const { byIdentifier, byId, error } = loadAuthority();
  if (error) return { ok: false, error };

  const suppliedSchemes = [
    ['companiesHouseNumber', 'uk.companieshouse.number'],
    ['sraNumber', 'uk.sra.number'],
    ['frn', 'uk.fca.frn'],
  ];

  const normalisers = {
    'uk.companieshouse.number': N.normaliseCompanyNumber,
    'uk.sra.number': N.normaliseNumericId,
    'uk.fca.frn': N.normaliseNumericId,
  };

  const matchedIds = new Set();
  const unsupported = [];
  for (const [key, scheme] of suppliedSchemes) {
    if (!input[key]) continue;
    if (!providers.byIdentifierScheme(scheme)) { unsupported.push(key); continue; }
    const id = byIdentifier.get(`${scheme}:${normalisers[scheme](input[key])}`);
    if (id) matchedIds.add(id);
  }
  // Any other identifier key supplied that this system has no provider for
  // at all (e.g. a SEC id) — flag explicitly rather than silently drop it.
  for (const key of Object.keys(input)) {
    if (key === 'name' || key === 'domain') continue;
    if (!suppliedSchemes.some(([k]) => k === key)) unsupported.push(key);
  }

  if (matchedIds.size > 1) {
    return {
      ok: false,
      conflict: true,
      candidates: [...matchedIds].map((id) => toCandidate(byId.get(id))),
    };
  }
  if (matchedIds.size === 1) {
    return { ok: true, organisationId: [...matchedIds][0], isNew: false, unsupported };
  }

  // Nothing matched an existing record — compute a new id from whatever was
  // supplied, per identity.js's precedence (unchanged). This is the discovery
  // fallback tier: strong identifiers that simply aren't in Repository
  // Authority yet, or a bare name+domain with no strong identifier at all.
  const computedId = canonicalOrgId(normaliseFacts(input));

  // The computed id may still coincide with an existing Repository Authority
  // record (e.g. a name+domain pair the batch build already assigned an id
  // to via the same fallback tier) — check before claiming "new".
  if (byId.has(computedId)) {
    return { ok: true, organisationId: computedId, isNew: false, unsupported };
  }
  return { ok: true, organisationId: computedId, isNew: true, unsupported };
}

// ── Canonical Organisation Resolution Service (Sprint 10) ─────────────────────
//
// resolveOrganisationByDomain(domain) is the ONE place a domain becomes an
// Organisation for the Observatory. It reads Repository Authority's domain index
// (build.js output) and NEVER guesses: only a single, verified, uncontested
// domain claim resolves. Every outcome carries provenance explaining why.

const RESOLUTION_OUTCOME = Object.freeze({
  RESOLVED:   'RESOLVED',    // exactly one verified, uncontested Organisation owns this domain
  NOT_FOUND:  'NOT_FOUND',   // no verified claim on this domain (or only an unverified candidate)
  AMBIGUOUS:  'AMBIGUOUS',   // more than one Organisation claims this domain — never assigned silently
  INVALID:    'INVALID',     // the input is not a resolvable domain
});

// A dissolved company status still RESOLVES — the organisation is still the
// correct owner of its historical domain; dissolution is surfaced in provenance
// (lifecycleStatus/dissolved), it does not change who the domain belongs to.
const DISSOLVED_STATUS_RE = /dissolv|liquidat|struck|closed|receivership|administration/i;

function isResolvableDomain(d) {
  return typeof d === 'string'
    && d.includes('.')
    && !d.startsWith('.') && !d.endsWith('.')
    && /^[a-z0-9.-]+$/.test(d);
}

// resolveOrganisationByDomain(rawDomain) →
//   { outcome, organisationId|null, candidates?, provenance }
function resolveOrganisationByDomain(rawDomain) {
  const domain = N.normaliseDomain(rawDomain);
  if (!isResolvableDomain(domain)) {
    return { outcome: RESOLUTION_OUTCOME.INVALID, organisationId: null,
      provenance: { reason: 'INPUT_NOT_A_DOMAIN', input: rawDomain ?? null } };
  }

  const { byDomain, byId, authorityVersion, error } = loadAuthority();
  if (error) {
    return { outcome: RESOLUTION_OUTCOME.NOT_FOUND, organisationId: null,
      provenance: { reason: 'NO_AUTHORITY_DATASET', detail: error, domain } };
  }

  const row = byDomain.get(domain);
  if (!row) {
    return { outcome: RESOLUTION_OUTCOME.NOT_FOUND, organisationId: null,
      provenance: { reason: 'NO_VERIFIED_DOMAIN_CLAIM', domain, authorityVersion } };
  }

  // An unverified candidate is a proposal, not an authoritative claim — resolving
  // on it would be guessing (RAER-7 / OC-6). Reported as NOT_FOUND, with the
  // candidate disclosed so it is auditable, never silently adopted.
  if (row.status !== 'verified') {
    return { outcome: RESOLUTION_OUTCOME.NOT_FOUND, organisationId: null,
      provenance: { reason: 'UNVERIFIED_CANDIDATE_ONLY', domain, status: row.status ?? null,
        candidateOrganisationId: row.organisationId ?? null, authorityVersion } };
  }

  const competing = Array.isArray(row.competingOrganisationIds) ? row.competingOrganisationIds.filter(Boolean) : [];
  if (row.contested === true || competing.length > 0) {
    const candidates = [...new Set([row.organisationId, ...competing].filter(Boolean))];
    return { outcome: RESOLUTION_OUTCOME.AMBIGUOUS, organisationId: null, candidates,
      provenance: { reason: 'CONTESTED_DOMAIN', domain, candidates, authorityVersion } };
  }

  if (!row.organisationId) {
    // A verified, uncontested row with no organisation id is malformed authority
    // data — never fabricate one.
    return { outcome: RESOLUTION_OUTCOME.NOT_FOUND, organisationId: null,
      provenance: { reason: 'CLAIM_WITHOUT_ORGANISATION', domain, authorityVersion } };
  }

  const org = byId.get(row.organisationId) || null;
  const lifecycleStatus = org && org.companiesHouse ? (org.companiesHouse.companyStatus ?? null) : null;
  const dissolved = lifecycleStatus ? DISSOLVED_STATUS_RE.test(lifecycleStatus) : false;

  return {
    outcome: RESOLUTION_OUTCOME.RESOLVED,
    organisationId: row.organisationId,
    provenance: {
      reason: 'VERIFIED_DOMAIN_CLAIM',
      domain,
      source: row.source ?? null,
      method: row.method ?? null,
      verificationDate: row.verificationDate ?? null,
      observationTier: row.observationTier ?? null,
      lifecycleStatus,
      dissolved,          // honoured (surfaced), not excluded
      authorityVersion,
    },
  };
}

// listOrganisationIds() — read-only population enumeration, reusing the
// already-loaded Repository Authority index. Added for ENG-014 WP-5's
// Scheduled Generation Trigger (ENG-032 §2), which needs "the existing
// Organisation population" and performs no enumeration logic of its own
// beyond invoking whatever read-only listing capability this layer exposes
// — this is that capability, not a new one WP-5 invents.
function listOrganisationIds() {
  return Array.from(loadAuthority().byId.keys());
}

module.exports = {
  search, reverse, firstOrganisationId, resolveIdentity, normaliseFacts, domainFromWebsite,
  listOrganisationIds,
  // Canonical Organisation Resolution Service
  resolveOrganisationByDomain, reload, RESOLUTION_OUTCOME,
};
