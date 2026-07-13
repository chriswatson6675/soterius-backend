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
const store = require('../../trust-intelligence/store');
const { computeChangeIndicator } = require('../../trust-intelligence/change-indicator');
const { authenticatedProjection } = require('../../trust-intelligence/projections');

// computeChangeIndicator only ever looks at the two most recent instances —
// fetching that bounded window at the query layer (rather than the full
// History via store.getHistory) keeps this endpoint's cost independent of
// how much History an Organisation has accumulated.
const CHANGE_INDICATOR_HISTORY_WINDOW = 2;

// Same non-oracle principle as requirePortfolio.js: /compare responds
// identically (404) whether a requested id doesn't exist globally or simply
// isn't in the caller's portfolio, so the response never discloses which.
const MAX_COMPARE_IDS = 10; // small, deliberate cap — bounds fan-out of N getCurrent() calls per request

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

// GET /api/portfolio/scores
// Same portfolio listing as GET /, plus each item's current Trust Score and
// change indicator (composed from the existing Trust Intelligence store —
// no new scoring). An item with no Trust Profile yet is not an error: it
// hydrates to currentTrustScore: null and change: { status: 'no-data' }.
// Registered before the /:organisationId param route (and before /compare's
// query-string route, for clarity) so Express's path-based matching can
// never treat "scores" as an :organisationId value.
function createGetPortfolioScores(
  getPortfolioItemsFn = getPortfolioItems,
  summariseFn = summariseById,
  getCurrentFn = store.getCurrent,
  getRecentHistoryFn = store.getRecentHistory,
) {
  return async function getPortfolioScores(req, res, next) {
    try {
      const items = await getPortfolioItemsFn(req.tenant.customer.id);
      const hydrated = await Promise.all(items.map(async (item) => {
        const [current, recentHistory] = await Promise.all([
          getCurrentFn(item.organisationId),
          getRecentHistoryFn(item.organisationId, CHANGE_INDICATOR_HISTORY_WINDOW),
        ]);
        return {
          ...item,
          organisation: summariseFn(item.organisationId),
          currentTrustScore: current.exists ? current.instance.trustScore.value : null,
          change: computeChangeIndicator(recentHistory),
        };
      }));
      res.json(hydrated);
    } catch (err) {
      next(err);
    }
  };
}

// GET /api/portfolio/compare?ids=ORG-AAA,ORG-BBB,...
// Returns the full current Trust Profile Instance for each requested
// organisation — but only for ids already in the caller's portfolio.
// All-or-nothing: any malformed id is a 400, any id not in this tenant's
// portfolio is the SAME 403 whether it doesn't exist globally or simply
// isn't tracked here (requirePortfolio.js's non-oracle convention), and
// either failure aborts the whole request rather than partially succeeding.
function createGetPortfolioCompare(getPortfolioItemFn = getPortfolioItem, getCurrentFn = store.getCurrent) {
  return async function getPortfolioCompare(req, res, next) {
    try {
      const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
      const ids = raw.split(',').map((id) => id.trim()).filter(Boolean);

      if (ids.length === 0) throw new ValidationError('ids query parameter is required');
      if (ids.length > MAX_COMPARE_IDS) {
        throw new ValidationError(`ids accepts at most ${MAX_COMPARE_IDS} organisations`);
      }
      for (const id of ids) {
        if (!ORG_ID_RE.test(id)) throw new ValidationError(`ids contains a malformed organisation id: ${id}`);
      }

      for (const id of ids) {
        const item = await getPortfolioItemFn(req.tenant.customer.id, id);
        if (!item) return res.status(403).json({ success: false, error: 'Forbidden' });
      }

      const organisations = await Promise.all(ids.map(async (organisationId) => {
        const current = await getCurrentFn(organisationId);
        // Same projection every other Trust Profile read route uses
        // (trust-profile.js's GET /:id and /:id/history) — never the raw
        // stored instance — so a future change to what the Authenticated
        // Projection redacts applies here too, not just there.
        return { organisationId, trustProfile: current.exists ? authenticatedProjection(current.instance) : null };
      }));

      res.json({ success: true, organisations });
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

router.get('/scores',             createGetPortfolioScores());
router.get('/compare',            createGetPortfolioCompare());
router.get('/',                   createGetPortfolio());
router.post('/',                  createPostPortfolio());
router.delete('/:organisationId', createDeletePortfolio());

module.exports = router;
module.exports.createGetPortfolio        = createGetPortfolio;
module.exports.createPostPortfolio       = createPostPortfolio;
module.exports.createDeletePortfolio     = createDeletePortfolio;
module.exports.createGetPortfolioScores  = createGetPortfolioScores;
module.exports.createGetPortfolioCompare = createGetPortfolioCompare;
