'use strict';

// publicScanDomainCooldown.js — ENG-010 §5.2 (T1.3 in ENG-013's WP1):
// per-domain scan-frequency throttling for the future public scan surface
// (ENG-009).
//
// Reuses the existing observation_sessions ledger as its only source of
// truth — no new store, no new table, no new cache (ENG-010 §0/§2.4's "reuse
// an already-governed store" discipline). This module is READ-ONLY: it never
// creates or transitions a session (grep-verifiable — no write calls of any
// kind anywhere below), so it introduces no duplicate orchestration and no
// duplicate state. Observation Sessions itself (observation-session.js) is
// untouched by this change.
//
// Deliberately does NOT validate the domain string (ENG-010 §4 — "the raw
// domain string purely as a throttling key, never inspected or validated by
// this layer"). Only trims/lowercases for key normalisation, matching the
// same normalisation already applied inline by the existing authenticated
// on-demand route (observation-sessions.js) and ENG-009's own route sketch —
// full validateDomain() checking remains the route handler's job, unchanged.
//
// Behaviour (elaborating ENG-010 §5.2, which names only the completed/
// partial cache-hit case): a recent on-demand session for this domain,
// within the configurable cooldown window, is handled by outcome:
//   - completed/partial  -> answered from the existing result (a cache-hit,
//                           per ENG-010 §5.2 — cheaper for caller and
//                           platform alike, not a rejection)
//   - running/queued     -> the pipeline is already mid-flight for this
//                           domain; point the caller at the existing session
//                           instead of starting a second, concurrent run for
//                           the same domain (this task's own "do not
//                           introduce duplicate orchestration" requirement,
//                           applied per-domain)
//   - failed/cancelled    -> still counts against the cooldown window (a
//                           failed attempt still consumed real external
//                           collector cost) but has no result to serve;
//                           rejected with 429 + Retry-After, same shape as
//                           the rate-limit axis. This specific disposition
//                           is an elaboration beyond ENG-010's literal text
//                           (which only names the completed/partial case) —
//                           recorded as such in ENG-013's implementation
//                           summary, not a silent addition.
//
// Fails open on a query error (logged) — an infrastructure read failure
// should not itself take down the public route; the per-IP rate limiter
// (publicScanRateLimit.js) still applies regardless.

const { getClient } = require('../../infra/database');
const logger = require('../../infra/utils/logger');

const COOLDOWN_MS = Number(process.env.PUBLIC_SCAN_DOMAIN_COOLDOWN_MS) || 6 * 60 * 60 * 1000; // 6 hours
const TRIGGER = 'on-demand';

const CACHE_HIT_STATUSES = ['completed', 'partial'];
const IN_PROGRESS_STATUSES = ['running', 'queued'];

function normaliseDomain(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
  return trimmed || null;
}

/**
 * @param {Object} [deps]
 * @param {Object} [deps.client] - injectable Supabase client (tests); defaults to getClient()
 *   resolved LAZILY, inside the returned middleware, on each request — never
 *   at factory-creation time. getClient() throws if SUPABASE_URL/
 *   SUPABASE_SERVICE_ROLE_KEY are unset; resolving it as a default parameter
 *   (evaluated the instant this factory is called, i.e. at module load for
 *   any router that mounts this middleware) would crash merely on require()
 *   in any environment without those env vars set — found for real once
 *   public-scan.js's own require of this module started tripping it.
 */
function createDomainCooldownCheck({ client } = {}) {
  return async function checkDomainCooldown(req, res, next) {
    const domain = normaliseDomain(req.body && req.body.domain);
    if (!domain) return next(); // no domain to key on — the route handler's own validation will reject this

    const sinceIso = new Date(Date.now() - COOLDOWN_MS).toISOString();
    const resolvedClient = client || getClient();

    const { data, error } = await resolvedClient
      .from('observation_sessions')
      .select('id, status, created_at, scope')
      .eq('trigger', TRIGGER)
      .filter('scope->>domain', 'eq', domain)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) {
      logger.error(`public-scan-protection axis=domain-cooldown decision=fail-open domain=${domain} error=${error.message}`);
      return next();
    }

    const recent = data && data[0];
    if (!recent) return next();

    if (CACHE_HIT_STATUSES.includes(recent.status)) {
      logger.info(`public-scan-protection axis=domain-cooldown decision=cache-hit domain=${domain} session=${recent.id} status=${recent.status}`);
      return res.status(200).json({
        success: true,
        cached: true,
        sessionId: recent.id,
        domain,
        status: recent.status,
      });
    }

    if (IN_PROGRESS_STATUSES.includes(recent.status)) {
      logger.info(`public-scan-protection axis=domain-cooldown decision=in-progress domain=${domain} session=${recent.id} status=${recent.status}`);
      return res.status(202).json({
        success: true,
        sessionId: recent.id,
        domain,
        status: recent.status,
        message: 'An observation for this domain is already in progress.',
      });
    }

    // failed / cancelled — still within the cooldown window, no result to serve.
    logger.warn(`public-scan-protection axis=domain-cooldown decision=reject domain=${domain} session=${recent.id} status=${recent.status}`);
    res.set('Retry-After', String(Math.ceil(COOLDOWN_MS / 1000)));
    return res.status(429).json({
      success: false,
      error: 'This domain was recently observed and the attempt did not complete. Please try again later.',
    });
  };
}

module.exports = { createDomainCooldownCheck, normaliseDomain, COOLDOWN_MS };
