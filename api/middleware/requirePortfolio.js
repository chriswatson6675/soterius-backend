const { getPortfolioItem } = require('../../infra/database');
const { isPortfolioGateEnabled } = require('./portfolioGateFlag');
const logger = require('../../infra/utils/logger');

/**
 * Portfolio authorisation gate (ADR-SYS-007 §4.4 — deny-by-default; §3.4 —
 * operations bypasses entirely). Must run after requireAuth + attachTenant —
 * reads req.user and req.tenant, and req.params[paramName] for the
 * organisation id.
 *
 * Gated behind ENABLE_PORTFOLIO_GATE (portfolioGateFlag.js, default false):
 * with the flag off this middleware is a no-op — next() immediately, no DB
 * call — so route protection can ship ahead of the portfolio-management UI
 * that would let a real customer populate a portfolio in the first place.
 * The authorisation logic below is fully implemented and tested regardless
 * of the flag (see requirePortfolio.test.js, which exercises it directly by
 * forcing isEnabledFn true) — turning the flag on later requires no code
 * change, only a config change.
 *
 * Returns 403 uniformly whether the organisation doesn't exist at all or
 * simply isn't in the caller's portfolio, so the response never discloses
 * which — deliberately, to avoid an existence oracle.
 */
function createRequirePortfolio(paramName, getPortfolioItemFn = getPortfolioItem, isEnabledFn = isPortfolioGateEnabled) {
  return async function requirePortfolio(req, res, next) {
    if (!isEnabledFn()) return next();

    try {
      if (req.user?.role === 'operations') return next();

      const organisationId = req.params[paramName];
      if (!req.tenant || !organisationId) {
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }

      const item = await getPortfolioItemFn(req.tenant.customer.id, organisationId);
      if (!item) return res.status(403).json({ success: false, error: 'Forbidden' });

      req.portfolioItem = item;
      next();
    } catch (err) {
      logger.error(`requirePortfolio threw: ${err.message}`);
      next(err);
    }
  };
}

module.exports = { createRequirePortfolio };
