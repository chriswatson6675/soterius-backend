const express = require('express');
const router  = express.Router();
const { AppError, ValidationError } = require('../../infra/utils/errors');
const logger   = require('../../infra/utils/logger');
const { executeScan } = require('../services/scanService');
const { validateDomain } = require('../../infra/utils/validators');
const {
  findOrCreateProspect, createProspect, getProspects, getProspectById,
  updateProspect, updateProspectLastScanned, deleteProspect,
  saveScan, getScanHistory, getBenchmarkData,
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
// Research Mode: find-or-create a prospect by website, run a full scan, persist
// the result, and return immediately — no gate form required.
// Optimised for batch use: a single API call handles the full workflow.
router.post('/quick-scan', async (req, res, next) => {
  try {
    const { firm_name, website, sector, location, source } = req.body;

    if (!website) throw new ValidationError('website is required');

    const domain = String(website).trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');
    if (!validateDomain(domain)) throw new ValidationError(`Invalid website domain: ${domain}`);

    const prospectResult = await findOrCreateProspect({
      firm_name: firm_name ? String(firm_name).trim() : domain,
      website:   domain,
      sector:    sector   ? String(sector).trim()   : null,
      location:  location ? String(location).trim() : null,
      source:    source   ? String(source).trim()   : 'manual',
    });

    if (!prospectResult.success) {
      throw new AppError(prospectResult.error || 'Failed to find or create prospect', 500);
    }

    const prospect = prospectResult.prospect;

    const { score, riskLevel, scannedAt, totalPoints, maxPoints, scanners, scoreObject } =
      await executeScan(domain);

    const scanRecord = await saveScan(domain, scoreObject, scanners, prospect.id);
    const scanId = scanRecord.success ? scanRecord.id : null;

    if (!scanRecord.success) {
      logger.error(`quick-scan: failed to persist scan for ${domain}: ${scanRecord.error}`);
    } else {
      await updateProspectLastScanned(prospect.id);
      logger.info(`quick-scan: ${prospect.firm_name} (${domain}) → ${score}% (${riskLevel})`);
    }

    res.json({
      success:    true,
      prospectId: prospect.id,
      created:    prospectResult.created ?? true,
      domain,
      scannedAt,
      score,
      riskLevel,
      totalPoints,
      maxPoints,
      scanners,
      scoreObject,
      scanId,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/prospects/benchmarks ─────────────────────────────────────────────
// Aggregates all prospect-linked scans into benchmark statistics:
//   bySector, byLocation, bandDistribution, topFailedChecks
router.get('/benchmarks', async (req, res, next) => {
  try {
    const raw = await getBenchmarkData();

    const bySector    = {};
    const byLocation  = {};
    const bandCounts  = {};
    const failedChecks = {};

    for (const scan of raw) {
      const prospect = scan.prospects;
      if (!prospect) continue;

      const score  = Number(scan.overall_score);
      const band   = scan.risk_band || 'Unknown';
      const sector = prospect.sector   || 'Unknown';
      const loc    = prospect.location || 'Unknown';

      if (!bySector[sector])   bySector[sector]   = { scores: [] };
      if (!byLocation[loc])    byLocation[loc]     = { scores: [] };
      bySector[sector].scores.push(score);
      byLocation[loc].scores.push(score);

      bandCounts[band] = (bandCounts[band] || 0) + 1;

      for (const scanner of (scan.scanner_results || [])) {
        for (const check of (scanner.checks || [])) {
          if (check.status === 'FAIL') {
            failedChecks[check.name] = (failedChecks[check.name] || 0) + 1;
          }
        }
      }
    }

    function aggregateGroup(group) {
      return Object.entries(group)
        .map(([label, { scores }]) => ({
          label,
          count:    scores.length,
          avgScore: scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : 0,
          minScore: scores.length ? Math.min(...scores) : 0,
          maxScore: scores.length ? Math.max(...scores) : 0,
        }))
        .sort((a, b) => b.count - a.count);
    }

    const topFailedChecks = Object.entries(failedChecks)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    res.json({
      success:          true,
      totalScans:       raw.length,
      bySector:         aggregateGroup(bySector),
      byLocation:       aggregateGroup(byLocation),
      bandDistribution: bandCounts,
      topFailedChecks,
    });
  } catch (err) {
    next(err);
  }
});

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
// Triggers a full security scan for a prospect, persists the scan record with
// prospect_id set, and updates last_scanned on the prospect.
router.post('/:id/scan', async (req, res, next) => {
  try {
    const prospect = await getProspectById(req.params.id);
    if (!prospect) return res.status(404).json({ success: false, error: 'Prospect not found' });

    const domain = prospect.website;
    if (!validateDomain(domain)) throw new ValidationError(`Prospect has invalid domain: ${domain}`);

    const { score, riskLevel, scannedAt, totalPoints, maxPoints, scanners, scoreObject } =
      await executeScan(domain);

    const scanRecord = await saveScan(domain, scoreObject, scanners, prospect.id);
    const scanId = scanRecord.success ? scanRecord.id : null;

    if (!scanRecord.success) {
      logger.error(`Failed to persist scan for prospect ${prospect.id}: ${scanRecord.error}`);
    } else {
      await updateProspectLastScanned(prospect.id);
      logger.info(`Prospect scan stored: ${scanId} for ${prospect.firm_name} (${domain})`);
    }

    res.json({
      success:    true,
      prospectId: prospect.id,
      domain,
      scannedAt,
      score,
      riskLevel,
      totalPoints,
      maxPoints,
      scanners,
      scoreObject,
      scanId,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
