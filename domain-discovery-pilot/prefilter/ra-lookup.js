'use strict';

// ra-lookup.js — read-only wrapper around organisation/resolve.js#search()
// for the Domain Discovery Pilot's prefilter. Never writes to Repository
// Authority; never imports authority/build.js or authority/loaders.js.
//
// resolve.js#search() returns { id, name, domain, regulator, sraNumber,
// companiesHouseNumber, frn, town } — it does NOT expose domainStatus or
// postcode (per Step 0 findings: resolve.js#toCandidate() only reads the
// merged organisations.ndjson row's verifiedDomain, not domainStatus, and
// Repository Authority carries no postcode field at all — build.js's merged
// schema has no address/postcode member). This module therefore reads
// organisations.ndjson directly, by id, ONLY for the small enrichment
// (domainStatus) that toCandidate() does not surface — a read-only,
// single-row lookup, never a full-file load beyond what resolve.js itself
// already loads into memory. postcode is honestly reported null (not
// fabricated) since Repository Authority has no such field.

const fs = require('fs');
const path = require('path');

let orgIndexCache = null; // Map<organisationId, row> — lazy-built once per process

function loadOrgIndexForEnrichment() {
  if (orgIndexCache) return orgIndexCache;
  const p = process.env.ORGANISATION_DATASET_PATH
    || path.join(__dirname, '..', '..', 'authority', 'dataset', 'organisations.ndjson');
  const index = new Map();
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      index.set(row.organisationId, row);
    }
  }
  orgIndexCache = index;
  return orgIndexCache;
}

function enrich(candidate, deps) {
  const index = deps && deps.orgIndex ? deps.orgIndex : loadOrgIndexForEnrichment();
  const row = index.get(candidate.id);
  return {
    ...candidate,
    domainStatus: row ? row.domainStatus ?? null : null,
    // No postcode field exists anywhere in Repository Authority's merged
    // schema (verified against organisations.ndjson's real shape in Step 0)
    // — honestly null, never guessed.
    postcode: null,
  };
}

/**
 * lookupCandidates({ name, tradingName }, deps) -> Organisation candidates,
 * unioned across a name search and (if tradingName differs) a trading-name
 * search, deduped by organisationId, each enriched with domainStatus.
 *
 * deps: { resolve, orgIndex, limit } — all injectable for offline tests.
 */
function lookupCandidates({ name, tradingName } = {}, deps = {}) {
  const resolveModule = deps.resolve || require('../../organisation/resolve');
  const limit = deps.limit ?? 8;

  const seen = new Map(); // organisationId -> candidate
  const queries = [name];
  if (tradingName && tradingName.trim() && tradingName.trim().toLowerCase() !== String(name || '').trim().toLowerCase()) {
    queries.push(tradingName);
  }

  for (const q of queries) {
    if (!q) continue;
    const result = resolveModule.search(q, { limit });
    if (!result.ok) continue;
    for (const candidate of result.results) {
      if (!seen.has(candidate.id)) seen.set(candidate.id, enrich(candidate, deps));
    }
  }

  return { ok: true, candidates: [...seen.values()] };
}

module.exports = { lookupCandidates, loadOrgIndexForEnrichment };
