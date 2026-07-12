'use strict';

// caa-ancestor-lookup.js — bounded ancestor-chain CAA collection for the
// On-Demand Observation Pipeline (ENG-007 §3.3, Phase 1).
//
// scoreCaaQuality(facts, population) resolves RFC 8659 §3 tree-climb
// inheritance from a population Map (caa-quality.js's resolveRelevantRRset).
// The national batch loader builds that map from the whole scored national
// population; a single on-demand domain does not need the whole population —
// only its OWN ancestor chain, and only when its own dns_caa_present is
// FALSE (confirmed absent, not unobserved). resolveRelevantRRset() never
// climbs when the target's own dns_caa_present is true or null, so this
// module mirrors that exact gate: a domain that already has its own CAA
// record (or whose CAA was not observed) triggers no extra lookups at all.
//
// Reuses collectCaa (the frozen collector) and makeCaaResolver (the
// dedicated TCP-capable DNS resolver run-national.js already uses, because
// CAA responses routinely exceed 512 bytes and need a TCP retry the default
// resolver does not perform) UNCHANGED — no second resolver implementation.

const { collectCaa } = require('../../collection/signals/caa/caa-collector');
const { makeCaaResolver } = require('../../collection/runs/national/run-national');

// A hard, structural cap — independent of any public-suffix logic (this
// module implements none; that would be a genuinely separate capability, out
// of Phase 1's scope). Bounds worst-case ancestor lookups regardless of how
// many labels a domain has.
const MAX_ANCESTOR_LEVELS = 5;

// The climb stops once only two labels remain (e.g. "example.com"). This is
// a structural bound, not a public-suffix-list-aware one: a domain under a
// multi-label public suffix (e.g. "example.co.uk") is not specially
// detected, and climbing may stop one level short of the true registrable
// boundary in that case. Acceptable for Phase 1 — it only narrows which
// ancestor levels are checked, it never fabricates or misattributes a CAA
// record, and RFC 8659 resolution degrades to "no ancestor found" rather
// than to an incorrect one.
function parentOf(domain) {
  const labels = domain.split('.');
  if (labels.length <= 2) return null;
  return labels.slice(1).join('.');
}

/**
 * Collect CAA facts for a domain's bounded ancestor chain, for use as the
 * `population` argument to scoreCaaQuality(). Only climbs when the target's
 * OWN facts show a confirmed absence (dns_caa_present === false) — the exact
 * condition under which resolveRelevantRRset() would otherwise search.
 *
 * @param {string} domain
 * @param {Object} targetFacts - the domain's own already-collected CAA facts
 * @param {Object} [deps] - { collect, resolver } — injectable for tests
 * @returns {Promise<Map<string, Object>>} domain -> facts, always including
 *   the target itself; ancestors are included up to and including the
 *   nearest one with dns_caa_present === true (a nearer ancestor always wins
 *   under RFC 8659 §3, so climbing stops there), or until the bound.
 */
async function collectCaaAncestorPopulation(domain, targetFacts, deps = {}) {
  const population = new Map([[domain, targetFacts]]);

  // Only a confirmed absence at this level triggers inheritance search —
  // mirrors resolveRelevantRRset's own gate exactly (true/null both skip).
  if (!targetFacts || targetFacts.dns_caa_present !== false) {
    return population;
  }

  const resolver = deps.resolver || makeCaaResolver();
  const collect = deps.collect || ((d) => collectCaa(d, { dnsResolver: resolver }));

  let current = domain;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level++) {
    const parent = parentOf(current);
    if (!parent) break;

    let facts;
    try {
      facts = await collect(parent);
    } catch {
      // A failed ancestor lookup does not abort the target's own scoring —
      // the ancestor is simply absent from the population, so
      // resolveRelevantRRset treats this level exactly as "no CAA found
      // here" and climbing continues to the next level.
      current = parent;
      continue;
    }

    population.set(parent, facts);

    // A confirmed CAA-publishing ancestor is the Relevant RRset — no
    // ancestor beyond it can ever be nearer, so further climbing is moot.
    if (facts.dns_caa_present === true) break;

    current = parent;
  }

  return population;
}

module.exports = { collectCaaAncestorPopulation, parentOf, MAX_ANCESTOR_LEVELS };
