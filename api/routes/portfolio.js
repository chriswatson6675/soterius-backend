const express = require('express');
const router  = express.Router();
const { AppError, ValidationError } = require('../../infra/utils/errors');
const {
  addPortfolioItem, getPortfolioItems, getPortfolioItem, removePortfolioItem,
} = require('../../infra/database');
const { requireAuth }   = require('../middleware/requireAuth');
const { attachTenant }  = require('../middleware/attachTenant');
const { requireTenant } = require('../middleware/requireTenant');

// Each handler is a factory over its DB dependency, mirroring the
// requireAuth/attachTenant/requirePortfolio middleware pattern, so route
// logic is testable without a real Supabase connection.

// GET /api/portfolio
// Returns the caller's portfolio, joined with organisation summary fields.
// Returns PortfolioItemDTO[] directly (no wrapper) — matches the
// organisations.js sub-resource convention (signals/timeline/improvement-queue).
function createGetPortfolio(getPortfolioItemsFn = getPortfolioItems) {
  return async function getPortfolio(req, res, next) {
    try {
      const items = await getPortfolioItemsFn(req.tenant.customer.id);
      res.json(items);
    } catch (err) {
      next(err);
    }
  };
}

// POST /api/portfolio
// Body: { organisationId }. Idempotent add — 201 if newly added, 200 if the
// organisation was already in the portfolio.
function createPostPortfolio(addPortfolioItemFn = addPortfolioItem) {
  return async function postPortfolio(req, res, next) {
    try {
      const { organisationId } = req.body;
      if (!organisationId) throw new ValidationError('organisationId is required');

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
