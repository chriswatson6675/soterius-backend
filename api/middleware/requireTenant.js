/**
 * 403 unless the caller has a resolved tenant (req.tenant, set by
 * attachTenant — must run after it). Portfolio CRUD is a customer-tenant
 * concept: both an unonboarded customer and an operations caller (never
 * tenant-scoped, per ADR-SYS-007 §3.4) get the same honest 403 here —
 * operations manages the platform through the Ops Console, not
 * /api/portfolio.
 *
 * Unlike requireAuth/attachTenant/requirePortfolio, this has no external
 * dependency to inject (it's a pure function of req.tenant), so it isn't a
 * factory — there's nothing to vary between production and tests.
 */
function requireTenant(req, res, next) {
  if (!req.tenant) return res.status(403).json({ success: false, error: 'No tenant for this account' });
  next();
}

module.exports = { requireTenant };
