'use strict';

// collection-profiles.js — named FCA collection profiles (pure data + selector).
//
// A collection profile is nothing more than an EXPLICIT, ordered subset of the
// firm-family endpoint catalogue (endpoint-map.js). It adds NO execution logic: a
// runner reads a profile's `endpoints` and hands them to endpoint-engine.executeAnchor
// exactly as the existing runners already do. This is the smallest possible
// configuration surface for limiting routine production collection — no collector
// redesign, no engine change, and the full-scope runners are untouched.
//
//   core — firm identity + declared website only (`firm`, `firm.address`). These are
//          the ONLY two endpoints any current Soterius consumer uses: ANL-FCA-001 §9
//          identifies the declared website + Companies House number as the platform
//          bridges, and the live cohort feed (backend/scripts/feeds/fca-enrich.js)
//          reads `/Firm/{FRN}/Address` for the website/domain. The Core profile runs
//          NO mega endpoints, NO grandchild traversal, and NO mega sizing probes
//          (the probe lives only in run-overnight.js and is never invoked here).
//
//   full — the complete firm family (every catalogue endpoint, mega people-endpoints
//          included). Mirrors the maximal scope the existing collector already
//          supports. The existing runners (run-overnight / run-pilot / run-largefirm)
//          continue to be the operational full profile, unchanged.
//
// Endpoint selection is intentionally explicit and trivially extensible: add an id
// to a list here; the engine needs no change [CR-FCA-04/15]. Profiles execute in the
// canonical parent→child→grandchild order via endpoint-map.orderFor [CR-FCA-02].

const { orderFor, FIRM_ORDER } = require('./endpoint-map');

// The two endpoints the current platform consumes.
//   firm         → identity, FRN anchor, firm name, Companies House number
//   firm.address → declared website (→ domain scanned by the technical observatory)
const CORE_ENDPOINTS = ['firm', 'firm.address'];

// Core + the authoritative classification source. The FCA Register exposes no direct
// Category/Sub-category field; classification is derived from the firm's regulated-
// activity set (firm.permissions). The Organisation Registry therefore needs Core
// (identity + website) plus firm.permissions, and nothing else.
const REGISTRY_ENDPOINTS = ['firm', 'firm.address', 'firm.permissions'];

const PROFILES = Object.freeze({
  core: Object.freeze({
    id: 'core',
    family: 'firm',
    description: 'Routine production: firm identity + declared website only.',
    endpoints: Object.freeze([...CORE_ENDPOINTS]),
    includesMega: false,
  }),
  registry: Object.freeze({
    id: 'registry',
    family: 'firm',
    description: 'Organisation Registry: identity + website + permissions (classification source).',
    endpoints: Object.freeze([...REGISTRY_ENDPOINTS]),
    includesMega: false,
  }),
  full: Object.freeze({
    id: 'full',
    family: 'firm',
    description: 'Complete firm family (all endpoints, incl. mega people-endpoints).',
    endpoints: Object.freeze([...FIRM_ORDER]),
    includesMega: true,
  }),
});

/** Look up a profile by id; throws on an unknown id (fail fast — no silent default). */
function profile(id) {
  const p = PROFILES[id];
  if (!p) throw new Error(`unknown collection profile '${id}' (known: ${Object.keys(PROFILES).join(', ')})`);
  return p;
}

/**
 * The deterministic, catalogue-ordered endpoint list for a profile. Reuses
 * endpoint-map.orderFor so a profile may list endpoints in any order and still
 * execute in canonical dependency order [CR-FCA-02].
 * @returns {string[]}
 */
function endpointsFor(id) {
  const p = profile(id);
  return orderFor(p.family, p.endpoints);
}

module.exports = { PROFILES, CORE_ENDPOINTS, REGISTRY_ENDPOINTS, profile, endpointsFor };
