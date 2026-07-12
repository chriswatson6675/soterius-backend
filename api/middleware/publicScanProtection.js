'use strict';

// publicScanProtection.js — ENG-010 in full (ENG-013 WP1): the composed
// protection layer for the future public scan surface (ENG-009).
//
// Ordering matches ENG-010 §3's placement diagram and §11's recommended
// build order — cheapest/stateless check first, so abusive traffic is
// rejected before any database read is attempted:
//   1. per-IP rate limit (hard cap + soft slowdown) — in-memory, no DB read
//   2. per-domain cooldown — one DB read, only for requests the rate
//      limiter already allowed through
//   3. global concurrency guard — one DB read, only for requests not
//      already resolved by a domain-cooldown cache-hit/in-progress response
//
// NOT mounted anywhere in server.js by this change — there is no public
// scan route yet (ENG-009/WP2 is out of scope for this change). This module
// exists so that route, when built, can do:
//
//   const { publicScanProtection } = require('../middleware/publicScanProtection');
//   router.use(...publicScanProtection());
//
// scoped to that router only — never via a global app.use() (ENG-010 §6).

const { createPublicScanRateLimit } = require('./publicScanRateLimit');
const { createDomainCooldownCheck } = require('./publicScanDomainCooldown');
const { createConcurrencyGuard } = require('./publicScanConcurrencyGuard');

/**
 * @param {Object} [deps] - forwarded to the domain-cooldown/concurrency-guard
 *   factories (e.g. { client } for tests); the rate limiter has no injectable
 *   dependency (stateless, in-memory).
 */
function publicScanProtection(deps = {}) {
  return [
    ...createPublicScanRateLimit(),
    createDomainCooldownCheck(deps),
    createConcurrencyGuard(deps),
  ];
}

module.exports = { publicScanProtection };
