const express = require('express');
const router  = express.Router();
const { AppError, ValidationError } = require('../../infra/utils/errors');
const {
  addPortfolioItem, getPortfolioItems, getPortfolioItem, removePortfolioItem,
} = require('../../infra/database');
const resolve = require('../../organisation/resolve');
const { summariseById } = require('../../organisation/summarise');
const { requireAuth }   = require('../middleware/requireAuth');
const { attachTenant }  = require('../middleware/attachTenant');
const { requireTenant } = require('../middleware/requireTenant');

// Canonical organisation id shape, per organisation/identity.js#canonicalOrgId:
// "ORG-" + the first 12 hex chars of a SHA-1, upper-cased. This is the ONLY
// value the portfolio may store — a legacy prospect UUID or any free text is
// rejected at the API layer (F-3), never persisted.
const ORG_ID_RE = /^ORG-[0-9A-F]{12}$/;

// Each handler is a factory over its dependencies, mirroring the
// requireAuth/attachTenant/requirePortfolio middleware pattern, so route
// logic is testable without a real Supabase connection or dataset on disk.

// GET /api/portfolio
// Returns the caller's portfolio. The stored row is a canonical ORG-* id only;
// each item's `organisation` summary is resolved here through the canonical
// Organisation layer (the same source the detail view uses), never duplicated
// into the portfolio table. Returns PortfolioItemDTO[] directly (no wrapper) —
// matches the organisations.js sub-resource convention.
function createGetPortfolio(getPortfolioItemsFn = getPortfolioItems, summariseFn = summariseById) {
  return async function getPortfolio(req, res, next) {
    try {
      const items = await getPortfolioItemsFn(req.tenant.customer.id);
      const hydrated = items.map((item) => ({
        ...item,
        organisation: summariseFn(item.organisationId),
      }));
      res.json(hydrated);
    } catch (err) {
      next(err);
    }
  };
}

// POST /api/portfolio
// Body: { organisationId }. Idempotent add — 201 if newly added, 200 if the
// organisation was already in the portfolio. Accepts ONLY a canonical ORG-*
// id that resolves to a real Repository Authority organisation (F-3) — a bad
// shape is 400, an unknown-but-well-formed id is 404; neither reaches the DB.
function createPostPortfolio(addPortfolioItemFn = addPortfolioItem, reverseFn = resolve.reverse) {
  return async function postPortfolio(req, res, next) {
    try {
      const { organisationId } = req.body;
      if (!organisationId) throw new ValidationError('organisationId is required');
      if (!ORG_ID_RE.test(organisationId)) {
        throw new ValidationError('organisationId must be a canonical ORG-* identifier');
      }

      const resolved = reverseFn(organisationId);
      if (!resolved.ok) throw new AppError(`Unknown organisation: ${organisationId}`, 404);

      const result = await addPortfolioItemFn(req.tenant.customer.id, organisationId, req.user.id);
      if (!result.success) throw new AppError(result.error || 'Failed to add to portfolio', 500);

      res.status(result.created ? 201 : 200).json({
        success: true,
        created: result.created,
        item: result.item,
      });
    } catch (err) {
      next(err);
    }
  };
}

// DELETE /api/portfolio/:organisationId
function createDeletePortfolio(getPortfolioItemFn = getPortfolioItem, removePortfolioItemFn = removePortfolioItem) {
  return async function deletePortfolio(req, res, next) {
    try {
      const existing = await getPortfolioItemFn(req.tenant.customer.id, req.params.organisationId);
      if (!existing) return res.status(404).json({ success: false, error: 'Portfolio item not found' });

      const result = await removePortfolioItemFn(req.tenant.customer.id, req.params.organisationId);
      if (!result.success) throw new AppError(result.error || 'Failed to remove from portfolio', 500);

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  };
}

// Portfolio is a customer-tenant concept — every route here needs a resolved
// tenant. Unlike requirePortfolio (organisation detail routes), this is not
// gated behind ENABLE_PORTFOLIO_GATE: these are new endpoints with no prior
// public behaviour to preserve, so there is nothing to roll back.
router.use(requireAuth, attachTenant, requireTenant);

router.get('/',                   createGetPortfolio());
router.post('/',                  createPostPortfolio());
router.delete('/:organisationId', createDeletePortfolio());

module.exports = router;
module.exports.createGetPortfolio    = createGetPortfolio;
module.exports.createPostPortfolio   = createPostPortfolio;
module.exports.createDeletePortfolio = createDeletePortfolio;
