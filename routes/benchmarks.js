const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');
const { getBenchmarkData } = require('../services/database');

// ── GET /api/benchmarks ───────────────────────────────────────────────────────
// Customer-accessible benchmark endpoint (no admin token required).
// Returns BenchmarkDTO directly. Accepts ?cohort= to filter by prospect source.
//
// Signal adoption is computed on-the-fly from stored scanner_results across all
// prospect-linked scans. Check names come from the real scanners (not the mock
// catalog) so they may differ from mock data until live scans are ingested.
router.get('/', async (req, res, next) => {
  try {
    const cohortFilter = req.query.cohort && req.query.cohort !== 'All'
      ? String(req.query.cohort).trim()
      : null;

    const raw = await getBenchmarkData();

    // Apply cohort filter: prospect.source matches cohort identifier
    const scans = cohortFilter
      ? raw.filter(s => s.prospects?.source === cohortFilter || s.prospects?.cohort === cohortFilter)
      : raw;

    if (!scans.length) {
      return res.json({
        cohort:           cohortFilter || 'All',
        totalScans:       0,
        bySector:         [],
        bandDistribution: {},
        topFailedChecks:  [],
        signalAdoption:   [],
      });
    }

    // ── Aggregations ──────────────────────────────────────────────────────────
    const bySector       = {};
    const bandCounts     = {};
    const failedChecks   = {};
    // signalAdoption: { checkName → { pass, total } }
    const signalCounts   = {};

    for (const scan of scans) {
      const prospect = scan.prospects;
      if (!prospect) continue;

      const score  = Number(scan.overall_score);
      const band   = scan.risk_band || 'Unknown';
      const sector = prospect.sector || 'Unknown';

      if (!bySector[sector]) bySector[sector] = { scores: [] };
      bySector[sector].scores.push(score);
      bandCounts[band] = (bandCounts[band] || 0) + 1;

      for (const scanner of (scan.scanner_results || [])) {
        for (const check of (scanner.checks || [])) {
          if (!signalCounts[check.name]) signalCounts[check.name] = { pass: 0, total: 0 };
          signalCounts[check.name].total += 1;
          if (check.status === 'PASS') signalCounts[check.name].pass += 1;
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

    const signalAdoption = Object.entries(signalCounts)
      .map(([name, { pass, total }]) => ({
        name,
        passPercent: total > 0 ? Math.round((pass / total) * 100) : 0,
      }))
      .sort((a, b) => b.passPercent - a.passPercent);

    res.json({
      cohort:           cohortFilter || 'All',
      totalScans:       scans.length,
      bySector:         aggregateGroup(bySector),
      bandDistribution: bandCounts,
      topFailedChecks,
      signalAdoption,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
