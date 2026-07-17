'use strict';

// Internal Commercial Observatory operator routes — NOT part of the
// customer/Trust Intelligence API surface, never linked from any
// customer-facing page. Powers the internal-only operator page at
// frontend /internal/observatory. Reuses the existing X-Admin-Token gate
// (same mechanism already used by /api/prospects, /api/gate, /api/renewal,
// /api/ops/acquisition) — no new authentication mechanism introduced.
//
// Reuses the Research Agent exactly as already built: createInvestigation
// (domain/create-investigation.js) + runResearchAgent (agent/orchestrator.js,
// dryRun: false so the run actually persists — an operator clicking
// "Investigate" here is performing a real investigation, not a rehearsal).
// This file adds no new agent logic — it only starts/reads it.

const express = require('express');
const router = express.Router();
const logger = require('../../infra/utils/logger');
const { createInvestigation } = require('../../commercial-observatory/domain/create-investigation');
const { runResearchAgent } = require('../../commercial-observatory/agent/orchestrator');
const persistence = require('../../commercial-observatory/persistence/db');

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}
router.use(requireAdmin);

// In-process only (not persisted — cleared on restart, capped in size) —
// the orchestrator's run-time report (rejectedFindings etc.) exists only
// as the resolved value of the runResearchAgent() promise; nothing else
// captures it. Keyed by investigationId so GET /:id can surface a
// rejected/skipped-discovery count (Part 10) once the run finishes.
const recentRunReports = new Map();
const MAX_CACHED_REPORTS = 50;
function cacheRunReport(investigationId, report) {
  recentRunReports.set(investigationId, report);
  if (recentRunReports.size > MAX_CACHED_REPORTS) {
    recentRunReports.delete(recentRunReports.keys().next().value);
  }
}

// POST / — creates an Investigation and starts a real agent run in the
// background. Responds as soon as the investigation exists (not once the
// run finishes) so the operator page can begin polling GET /:id
// immediately; the agent run itself continues after the response is sent.
router.post('/', async (req, res) => {
  const { name, domain } = req.body || {};
  if (!name && !domain) {
    return res.status(400).json({ success: false, error: 'name or domain is required' });
  }

  const created = await createInvestigation({ name, domain });
  if (!created.success) {
    return res.status(400).json({ success: false, error: created.error });
  }

  runResearchAgent(created.investigationId, { dryRun: false })
    .then((report) => cacheRunReport(created.investigationId, report))
    .catch((err) => {
      logger.error(`internal-observatory: agent run failed for investigation ${created.investigationId}: ${err.message}`);
    });

  res.json({ success: true, investigationId: created.investigationId });
});

// GET / — recent investigations + whole-population summary stats, for the
// operator page's landing view (Recent Investigations / Status / Averages).
router.get('/', async (req, res) => {
  const [listResult, statsResult] = await Promise.all([
    persistence.listRecentInvestigations({ limit: 20 }),
    persistence.getObservatoryStats(),
  ]);
  if (!listResult.success) return res.status(500).json({ success: false, error: listResult.error });
  if (!statsResult.success) return res.status(500).json({ success: false, error: statsResult.error });

  res.json({
    success: true,
    investigations: listResult.investigations.map((inv) => ({
      id: inv.id, targetName: inv.targetName, targetDomain: inv.targetDomain, status: inv.status,
    })),
    statusCounts: statsResult.statusCounts,
    averages: statsResult.averages,
  });
});

// GET /portfolio — the full Investigation Portfolio: every investigation
// with its evidence/claim/relationship/discovery counts, draft state,
// question-backlog completeness, and duration, plus the same summary
// statistics GET / already exposes. Registered BEFORE GET /:id so the
// literal path "portfolio" is never swallowed by the :id param route.
router.get('/portfolio', async (req, res) => {
  const [portfolioResult, statsResult] = await Promise.all([
    persistence.getPortfolio({ limit: 200 }),
    persistence.getObservatoryStats(),
  ]);
  if (!portfolioResult.success) return res.status(500).json({ success: false, error: portfolioResult.error });
  if (!statsResult.success) return res.status(500).json({ success: false, error: statsResult.error });

  res.json({
    success: true,
    investigations: portfolioResult.investigations,
    statusCounts: statsResult.statusCounts,
    averages: statsResult.averages,
  });
});

// GET /:id — one combined snapshot for polling: investigation status,
// agent events (newest first, for the live activity feed), and whatever of
// evidence/claims/discoveries/relationships/draft already exist. Several of
// these persist incrementally as the (non-dry-run) agent progresses, so
// this genuinely reflects live progress, not just the final result.
router.get('/:id', async (req, res) => {
  const bundleResult = await persistence.getInvestigationBundle(req.params.id);
  if (!bundleResult.success) {
    return res.status(404).json({ success: false, error: bundleResult.error });
  }
  const { bundle } = bundleResult;
  const cachedReport = recentRunReports.get(req.params.id);
  const rejectedByDiscoveryGate = cachedReport
    ? cachedReport.rejectedFindings.filter((r) => r.stage === 'discovery_quality_gate').length
    : null;
  res.json({
    success: true,
    investigation: bundle.investigation,
    events: [...bundle.agentEvents].reverse(),
    evidenceCount: bundle.evidence.length,
    claims: bundle.claims,
    discoveries: bundle.discoveries,
    relationshipObservations: bundle.relationshipObservations,
    draft: bundle.draft,
    // null while the run is still in-flight or after a server restart —
    // only ever populated once this run's own report has been cached.
    rejectedByDiscoveryGateCount: rejectedByDiscoveryGate,
  });
});

module.exports = router;
