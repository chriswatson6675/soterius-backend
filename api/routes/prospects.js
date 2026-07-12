const express = require('express');
const router  = express.Router();
const { AppError, ValidationError } = require('../../infra/utils/errors');
const logger   = require('../../infra/utils/logger');
const { validateDomain } = require('../../infra/utils/validators');
const { computeBenchmarkAggregates } = require('../services/benchmarkAggregation');
const { runOnDemandObservation } = require('../../observatory/on-demand/on-demand-observation');
const {
  findOrCreateProspect, createProspect, getProspects, getProspectById,
  updateProspect, updateProspectLastScanned, deleteProspect,
  getScanHistory, getBenchmarkData,
} = require('../../infra/database');

// ── Admin auth guard ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

router.use(requireAdmin);

// ── POST /api/prospects/quick-scan ───────────────────────────────────────────
// Research Mode: find-or-create a prospect by website and trigger a fresh
// canonical observation for it — no gate form required.
//
// ENG-012 §1.2 / §2 item 1 (T3.4, ENG-013 WP3): previously called the legacy
// scan service's synchronous scan function directly and persisted its
// derived score object to the scans table. Now delegates to the SAME
// on-demand orchestrator the
// authenticated customer-facing trigger uses (backend/api/routes/
// observation-sessions.js's POST /on-demand) — reusing runOnDemandObservation
// unmodified, never re-implementing it (no duplicate orchestration). Response
// is now async (202 + sessionId), matching that route's own contract, since
// the canonical pipeline is not a synchronous call. Caller polls
// GET /api/observation-sessions/:id for completion.
//
// Note: this endpoint no longer writes a `scans` row or updates a prospect's
// legacy scan-history/last_scanned by scan CONTENT — canonical Observations
// are domain-keyed, not prospect-keyed (ENG-007 §4.6). last_scanned is still
// updated, marking that an observation was requested, not that a legacy scan
// completed — a deliberate, minimal preservation of that one side effect
// (recorded in ENG-013 WP3's implementation summary as a behaviour change).
function createQuickScanHandler(deps = {}) {
  const {
    findOrCreateProspectFn = findOrCreateProspect,
    updateProspectLastScannedFn = updateProspectLastScanned,
    runOnDemand = runOnDemandObservation,
  } = deps;

  return function postQuickScan(req, res, next) {
    const { firm_name, website, sector, location, source } = req.body;

    if (!website) return next(new ValidationError('website is required'));

    const domain = String(website).trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');
    if (!validateDomain(domain)) return next(new ValidationError(`Invalid website domain: ${domain}`));

    findOrCreateProspectFn({
      firm_name: firm_name ? String(firm_name).trim() : domain,
      website:   domain,
      sector:    sector   ? String(sector).trim()   : null,
      location:  location ? String(location).trim() : null,
      source:    source   ? String(source).trim()   : 'manual',
    }).then((prospectResult) => {
      if (!prospectResult.success) {
        return next(new AppError(prospectResult.error || 'Failed to find or create prospect', 500));
      }

      const prospect = prospectResult.prospect;
      let responded = false;

      runOnDemand(domain, {
        requestedBy: null,
        onSessionCreated: (session) => {
          responded = true;
          updateProspectLastScannedFn(prospect.id).catch((err) => {
            logger.error(`quick-scan: failed to update last_scanned for ${prospect.id}: ${err.message}`);
          });
          logger.info(`quick-scan: on-demand observation triggered for ${prospect.firm_name} (${domain}) — session ${session.id}`);
          res.status(202).json({
            success:    true,
            prospectId: prospect.id,
            created:    prospectResult.created ?? true,
            domain,
            sessionId:  session.id,
          });
        },
      }).then((result) => {
        if (!responded) {
          logger.error(`quick-scan: on-demand session creation failed for ${domain}: ${result.error}`);
          res.status(502).json({ success: false, error: result.error || 'on-demand observation failed to start' });
        }
      }).catch((err) => {
        logger.error(`quick-scan: on-demand observation pipeline threw for ${domain}: ${err.message}`);
        if (!responded) res.status(502).json({ success: false, error: 'on-demand observation failed to start' });
      });
    }).catch(next);
  };
}

router.post('/quick-scan', createQuickScanHandler());

// ── GET /api/prospects/benchmarks ─────────────────────────────────────────────
// Aggregates all prospect-linked scans into benchmark statistics:
//   bySector, byLocation, bandDistribution, topFailedChecks
//
// ENG-012 §1.3 / §2 item 1 (T3.3, ENG-013 WP3): the aggregation itself is
// delegated to computeBenchmarkAggregates() — the single canonical
// implementation shared with backend/api/routes/benchmarks.js. This route no
// longer re-derives the aggregation inline.
function createGetProspectBenchmarks(getBenchmarkDataFn = getBenchmarkData) {
  return async function getProspectBenchmarks(req, res, next) {
    try {
      const raw = await getBenchmarkDataFn();
      const agg = computeBenchmarkAggregates(raw);

      res.json({
        success:          true,
        totalScans:       agg.totalScans,
        bySector:         agg.bySector,
        byLocation:       agg.byLocation,
        bandDistribution: agg.bandDistribution,
        topFailedChecks:  agg.topFailedChecks,
      });
    } catch (err) {
      next(err);
    }
  };
}

router.get('/benchmarks', createGetProspectBenchmarks());

// ── GET /api/prospects ────────────────────────────────────────────────────────
// Returns all prospects ordered: unscanned first, then least recently scanned.
// Optional query filters: ?sector=solicitors &location=London &source=manual
router.get('/', async (req, res, next) => {
  try {
    const filters = {};
    if (req.query.sector)   filters.sector   = String(req.query.sector).trim();
    if (req.query.location) filters.location = String(req.query.location).trim();
    if (req.query.source)   filters.source   = String(req.query.source).trim();

    const prospects = await getProspects(filters);
    res.json({ success: true, count: prospects.length, prospects });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/prospects ───────────────────────────────────────────────────────
// Creates a new prospect. website is normalised to a bare domain (no scheme/path).
router.post('/', async (req, res, next) => {
  try {
    const { firm_name, website, sector, location, source, notes } = req.body;

    if (!firm_name) throw new ValidationError('firm_name is required');
    if (!website)   throw new ValidationError('website is required');

    // Normalise: strip scheme, strip trailing slash
    const domain = String(website).trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');
    if (!validateDomain(domain)) throw new ValidationError(`Invalid website domain: ${domain}`);

    const result = await createProspect({
      firm_name: String(firm_name).trim(),
      website:   domain,
      sector:    sector   ? String(sector).trim()   : null,
      location:  location ? String(location).trim() : null,
      source:    source   ? String(source).trim()   : 'manual',
      notes:     notes    ? String(notes).trim()    : null,
    });

    if (!result.success) {
      // Duplicate website returns a 409 so callers can detect and handle
      const isDupe = result.error?.includes('already exists');
      throw new AppError(result.error || 'Failed to create prospect', isDupe ? 409 : 500);
    }

    res.status(201).json({ success: true, prospect: result.prospect });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/prospects/:id ────────────────────────────────────────────────────
// Returns a single prospect with its full scan history.
router.get('/:id', async (req, res, next) => {
  try {
    const prospect = await getProspectById(req.params.id);
    if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });

    const history = await getScanHistory(prospect.website, 50);

    res.json({ success: true, prospect, scanHistory: history });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/prospects/:id ──────────────────────────────────────────────────
// Updates mutable fields. website is not patchable (FK and domain are tied together).
router.patch('/:id', async (req, res, next) => {
  try {
    const { firm_name, sector, location, source, notes } = req.body;
    const updates = {};
    if (firm_name !== undefined) updates.firm_name = String(firm_name).trim();
    if (sector    !== undefined) updates.sector    = sector    ? String(sector).trim()    : null;
    if (location  !== undefined) updates.location  = location  ? String(location).trim()  : null;
    if (source    !== undefined) updates.source    = source    ? String(source).trim()    : null;
    if (notes     !== undefined) updates.notes     = notes     ? String(notes).trim()     : null;

    if (Object.keys(updates).length === 0) {
      throw new ValidationError('No updatable fields provided');
    }

    const result = await updateProspect(req.params.id, updates);
    if (!result.success) throw new AppError(result.error || 'Update failed', 500);

    res.json({ success: true, prospect: result.prospect });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/prospects/:id ─────────────────────────────────────────────────
// Deletes the prospect and all its linked scan records permanently.
router.delete('/:id', async (req, res, next) => {
  try {
    const prospect = await getProspectById(req.params.id);
    if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });

    const result = await deleteProspect(req.params.id);
    if (!result.success) throw new AppError(result.error || 'Delete failed', 500);

    logger.info(`Prospect deleted: ${prospect.firm_name} (${prospect.website})`);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/prospects/:id/scan ──────────────────────────────────────────────
// Triggers a fresh canonical observation for a prospect's domain.
//
// ENG-012 §1.2 / §2 item 1 (T3.4, ENG-013 WP3): same migration as quick-scan
// above — delegates to the shared, unmodified runOnDemandObservation
// orchestrator rather than the legacy scan service's synchronous scan
// function. Async (202 + sessionId); caller polls
// GET /api/observation-sessions/:id.
function createProspectScanHandler(deps = {}) {
  const {
    getProspectByIdFn = getProspectById,
    updateProspectLastScannedFn = updateProspectLastScanned,
    runOnDemand = runOnDemandObservation,
  } = deps;

  return function postProspectScan(req, res, next) {
    getProspectByIdFn(req.params.id).then((prospect) => {
      if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });

      const domain = prospect.website;
      if (!validateDomain(domain)) return next(new ValidationError(`Prospect has invalid domain: ${domain}`));

      let responded = false;

      runOnDemand(domain, {
        requestedBy: null,
        onSessionCreated: (session) => {
          responded = true;
          updateProspectLastScannedFn(prospect.id).catch((err) => {
            logger.error(`prospect scan: failed to update last_scanned for ${prospect.id}: ${err.message}`);
          });
          logger.info(`Prospect on-demand observation triggered: session ${session.id} for ${prospect.firm_name} (${domain})`);
          res.status(202).json({
            success:    true,
            prospectId: prospect.id,
            domain,
            sessionId:  session.id,
          });
        },
      }).then((result) => {
        if (!responded) {
          logger.error(`Prospect scan: session creation failed for ${domain}: ${result.error}`);
          res.status(502).json({ success: false, error: result.error || 'on-demand observation failed to start' });
        }
      }).catch((err) => {
        logger.error(`Prospect scan: pipeline threw for ${domain}: ${err.message}`);
        if (!responded) res.status(502).json({ success: false, error: 'on-demand observation failed to start' });
      });
    }).catch(next);
  };
}

router.post('/:id/scan', createProspectScanHandler());

module.exports = router;
module.exports.createQuickScanHandler       = createQuickScanHandler;
module.exports.createGetProspectBenchmarks  = createGetProspectBenchmarks;
module.exports.createProspectScanHandler    = createProspectScanHandler;
