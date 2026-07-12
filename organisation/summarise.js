'use strict';

// summarise.js — a lightweight canonical Organisation summary for LIST
// contexts (the customer portfolio), per ADR-SYS-010 §2.2.
//
// The portfolio stores only a canonical ORG-* id (migration 038); it holds no
// organisation display data of its own. When a list needs to show each tracked
// organisation, it resolves the summary HERE — from the same canonical
// Organisation layer the detail view (assemble.assembleById) is built on, so
// list and detail never diverge or duplicate.
//
// Why not reuse assembleById for a list: assembleById does a live Companies
// House fetch and ten Observatory reads PER organisation — correct for one
// detail page, wrong to fan out across a portfolio. This projects only the
// identity tier (name, verified domain) straight from Repository Authority's
// already-merged row via resolve.reverse — in-memory, no network. The name and
// domain returned are exactly the values assembleById would seed from the same
// row (facts.name / facts.domain), so the two views agree by construction.
//
// sector / location / lastScannedAt have no source in Repository Authority's
// identity tier (its merged rows carry no office/address detail — see
// resolve.toCandidate's `town: null` note — and no scan timestamp). They are
// honestly null here rather than fabricated (OC-4); the detail view surfaces
// address, classification and Observatory data through the fuller assembly.

const resolve = require('./resolve');

/**
 * @param {string} orgId - canonical ORG-* id
 * @param {{ reverse?: (id: string) => {ok: boolean, row?: object, error?: string} }} [deps]
 * @returns {{id: string, name: string|null, domain: string|null, sector: null, location: null, lastScannedAt: null} | null}
 *          the summary, or null when the id is not in Repository Authority
 */
function summariseById(orgId, { reverse = resolve.reverse } = {}) {
  const result = reverse(orgId);
  if (!result.ok) return null;

  const row = result.row;
  return {
    id: row.organisationId,
    name: row.organisationName || row.canonicalName || null,
    domain: row.verifiedDomain || null,
    // Not in the identity tier — resolved on the detail view, not the list.
    sector: null,
    location: null,
    lastScannedAt: null,
  };
}

module.exports = { summariseById };
