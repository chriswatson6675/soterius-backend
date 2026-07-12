'use strict';

// publicScanRateLimit.js — ENG-010 §5.1 (T1.1 in ENG-013's WP1): per-caller
// (IP-keyed) rate limiting for the future public scan surface (ENG-009).
//
// Infrastructure only (ENG-010 §4) — no domain/organisation/trust knowledge,
// purely transport-level (caller IP, request rate). Exported as a composable
// middleware pair for whichever route mounts it; NOT mounted anywhere in
// server.js by this change (there is no public scan route yet — that is
// ENG-009/WP2, out of scope here). Must never be applied via a global
// app.use() (ENG-010 §6) — only ever scoped to the future public route.
//
// Two behaviours, both keyed on the corrected req.ip (accurate only once
// server.js's `trust proxy` setting is correct — see server.js):
//   - hard cap: express-rate-limit rejects with 429 + Retry-After once the
//     window ceiling is reached. No partial processing occurs.
//   - soft slowdown: once past a configurable fraction of the ceiling but
//     still under it, the request is delayed (not rejected) before reaching
//     the route handler — a graduated approach to the cliff-edge rather than
//     an abrupt cutoff. ENG-010 §5.1 names the express-slow-down pairing as
//     one way to do this "but not mandated by name" — this implementation
//     reads express-rate-limit's own per-request counters instead of adding
//     a second stateful package, a deliberate scope reduction recorded in
//     ENG-013's implementation summary.
//
// Stateless (in-memory, per ENG-010 §2.4 — no Redis/queue exists in this
// backend); does not survive a multi-replica deployment without a shared
// store, a known limitation ENG-010 §11.4/ENG-013 §1.4 already flags.

const rateLimit = require('express-rate-limit');
const logger = require('../../infra/utils/logger');

const WINDOW_MS = Number(process.env.PUBLIC_SCAN_RATE_WINDOW_MS) || 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS = Number(process.env.PUBLIC_SCAN_RATE_MAX) || 30;
const SOFT_THRESHOLD_RATIO = Number(process.env.PUBLIC_SCAN_RATE_SOFT_RATIO) || 0.7;
const SOFT_DELAY_MS = Number(process.env.PUBLIC_SCAN_RATE_SOFT_DELAY_MS) || 1500;

function hardLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn(`public-scan-protection axis=per-ip-hard decision=reject ip=${req.ip}`);
      res.set('Retry-After', String(Math.ceil(WINDOW_MS / 1000)));
      res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.',
      });
    },
  });
}

// Runs only for requests the hard limiter above already allowed through
// (req.rateLimit is populated by express-rate-limit regardless of outcome).
function softThrottle(req, res, next) {
  const info = req.rateLimit;
  if (!info || typeof info.remaining !== 'number' || typeof info.limit !== 'number' || info.limit <= 0) {
    return next();
  }

  const used = info.limit - info.remaining;
  const ratio = used / info.limit;

  if (ratio >= SOFT_THRESHOLD_RATIO) {
    logger.info(`public-scan-protection axis=per-ip-soft decision=throttle ip=${req.ip} used=${used}/${info.limit}`);
    setTimeout(next, SOFT_DELAY_MS);
    return;
  }
  next();
}

/**
 * Returns an ordered middleware array: [hard cap, soft slowdown]. Compose
 * with the other public-scan-protection middlewares via
 * router.use(...createPublicScanRateLimit(), ...) once ENG-009's public
 * route exists.
 */
function createPublicScanRateLimit() {
  return [hardLimiter(), softThrottle];
}

module.exports = {
  createPublicScanRateLimit,
  WINDOW_MS,
  MAX_REQUESTS,
  SOFT_THRESHOLD_RATIO,
  SOFT_DELAY_MS,
};
