const express = require('express');
const router  = express.Router();
const logger  = require('../../infra/utils/logger');
const { getBenchmarkData } = require('../../infra/database');
const { computeBenchmarkAggregates } = require('../services/benchmarkAggregation');

// ── GET /api/benchmarks ───────────────────────────────────────────────────────
// Customer-accessible benchmark endpoint (no admin token required).
// Returns BenchmarkDTO directly. Accepts ?cohort= to filter by prospect source.
//
// Signal adoption is computed on-the-fly from stored scanner_results across all
// prospect-linked scans. Check names come from the real scanners (not the mock
// catalog) so they may differ from mock data until live scans are ingested.
//
// ENG-012 §1.3 / §2 item 1 (T3.3, ENG-013 WP3): the aggregation itself is
// delegated to computeBenchmarkAggregates() — the single canonical
// implementation shared with backend/api/routes/prospects.js's own
// GET /benchmarks. This route no longer re-derives the aggregation inline.
function createGetBenchmarks(getBenchmarkDataFn = getBenchmarkData) {
  return async function getBenchmarks(req, res, next) {
    try {
      const cohortFilter = req.query.cohort && req.query.cohort !== 'All'
        ? String(req.query.cohort).trim()
        : null;

      const raw = await getBenchmarkDataFn();

      // Apply cohort filter: prospect.source matches cohort identifier
      const scans = cohortFilter
        ? raw.filter(s => s.prospects?.source === cohortFilter || s.prospects?.cohort === cohortFilter)
        : raw;

      const agg = computeBenchmarkAggregates(scans);

      res.json({
        cohort:           cohortFilter || 'All',
        totalScans:       agg.totalScans,
        bySector:         agg.bySector,
        bandDistribution: agg.bandDistribution,
        topFailedChecks:  agg.topFailedChecks,
        signalAdoption:   agg.signalAdoption,
      });
    } catch (err) {
      next(err);
    }
  };
}

router.get('/', createGetBenchmarks());

module.exports = router;
module.exports.createGetBenchmarks = createGetBenchmarks;
