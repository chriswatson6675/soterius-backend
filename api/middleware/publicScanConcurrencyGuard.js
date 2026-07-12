'use strict';

// publicScanConcurrencyGuard.js — ENG-010 §5.3 (T1.4 in ENG-013's WP1):
// system-wide in-flight concurrency ceiling for the future public scan
// surface (ENG-009).
//
// Reuses the existing observation_sessions ledger (no new store, per ENG-010
// §0/§2.4). READ-ONLY — no write call of any kind anywhere below — so this
// introduces no duplicate state and no duplicate orchestration; Observation
// Sessions itself is untouched.
//
// Distinct from the rate-limit (per-caller) and domain-cooldown (per-domain)
// axes: this guards the platform's own outbound collector capacity, not any
// individual caller's fairness (ENG-010 §5.3) — rejection here is a system-
// capacity signal, not a caller-behaviour judgement, so it returns 503, never
// 429.
//
// Fails open on a query error (logged), matching publicScanDomainCooldown.js
// — an infrastructure read failure should not itself take the public route
// down; the per-IP rate limiter still applies regardless.

const { getClient } = require('../../infra/database');
const logger = require('../../infra/utils/logger');

const CONCURRENCY_CEILING = Number(process.env.PUBLIC_SCAN_CONCURRENCY_MAX) || 5;
const RETRY_AFTER_SECONDS = Number(process.env.PUBLIC_SCAN_CONCURRENCY_RETRY_AFTER_S) || 30;
const TRIGGER = 'on-demand';
const RUNNING_STATUS = 'running';

/**
 * @param {Object} [deps]
 * @param {Object} [deps.client] - injectable Supabase client (tests); defaults to getClient()
 *   resolved LAZILY, inside the returned middleware, on each request — never
 *   at factory-creation time (see publicScanDomainCooldown.js's identical
 *   fix and its comment for why this matters).
 */
function createConcurrencyGuard({ client } = {}) {
  return async function checkConcurrency(req, res, next) {
    const resolvedClient = client || getClient();
    const { count, error } = await resolvedClient
      .from('observation_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('trigger', TRIGGER)
      .eq('status', RUNNING_STATUS);

    if (error) {
      logger.error(`public-scan-protection axis=concurrency decision=fail-open error=${error.message}`);
      return next();
    }

    const inFlight = count ?? 0;
    if (inFlight >= CONCURRENCY_CEILING) {
      logger.warn(`public-scan-protection axis=concurrency decision=reject inFlight=${inFlight}/${CONCURRENCY_CEILING}`);
      res.set('Retry-After', String(RETRY_AFTER_SECONDS));
      return res.status(503).json({
        success: false,
        error: 'The observation pipeline is at capacity. Please try again shortly.',
      });
    }

    next();
  };
}

module.exports = { createConcurrencyGuard, CONCURRENCY_CEILING, RETRY_AFTER_SECONDS };
