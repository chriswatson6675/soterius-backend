const express = require('express');
const router  = express.Router();
const { getProspects, getScanHistory, getPortfolioItems } = require('../../infra/database');
const { isPortfolioGateEnabled } = require('../middleware/portfolioGateFlag');
const { requireAuth }  = require('../middleware/requireAuth');
const { attachTenant } = require('../middleware/attachTenant');

const SCANNER_TO_CATEGORY = {
  email:    'A',
  ssl:      'D',
  headers:  'C',
  vulnComp: 'F',
  gdpr:     'H',
};

const SCANNER_NAME_TO_KEY = {
  'SSL/TLS Encryption':       'ssl',
  'Email Security':           'email',
  'Security Headers':         'headers',
  'Vulnerable Components':    'vulnComp',
  'GDPR / Cookie Compliance': 'gdpr',
};

function buildImprovementQueueItems(prospects, scanHistoriesByProspectId) {
  const items = [];

  for (const p of prospects) {
    const scan = scanHistoriesByProspectId.get(p.id) || null;
    if (!scan || !Array.isArray(scan.scanner_results)) continue;

    for (const scanner of scan.scanner_results) {
      const key          = SCANNER_NAME_TO_KEY[scanner.name];
      const categoryCode = (key && SCANNER_TO_CATEGORY[key]) || 'F';

      for (let i = 0; i < (scanner.checks || []).length; i++) {
        const check = scanner.checks[i];
        if (check.status === 'PASS') continue;

        items.push({
          id:                    `iq-${scan.id}-${key || 'unk'}-${i}`,
          organisationId:        p.id,
          organisationName:      p.firm_name,
          organisationDomain:    p.website,
          signalId:              `SOT-SCAN-${(key || 'UNK').toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
          signalName:            check.name,
          categoryCode,
          priority:              check.status === 'FAIL' ? 'high' : 'medium',
          observableIssue:       check.details || check.name,
          whyItMatters:          `Affects ${scanner.name} trust posture.`,
          expectedImpactBand:    'Good',
          implementationStatus:  'open',
          supportingEvidenceIds: [scan.id],
          raisedAt:              scan.scanned_at,
        });
      }
    }
  }

  // FAILs first, then WARNINGs
  return items.sort((a, b) =>
    a.priority === 'high' && b.priority !== 'high' ? -1
    : b.priority === 'high' && a.priority !== 'high' ? 1
    : 0
  );
}

/**
 * GET /api/improvement-queue
 *
 * operations: unchanged — platform-wide, every prospect (ADR-SYS-007 §3.4).
 * customer: scoped to the caller's portfolio only, gated behind
 * ENABLE_PORTFOLIO_GATE (default false, portfolioGateFlag.js). With the flag
 * off this is byte-identical to the pre-slice behaviour for every role,
 * since requireAuth/attachTenant are the only unconditional additions here
 * (the endpoint was previously fully public). No tenant / empty portfolio →
 * 200 [] — a legitimate empty state, not an error; the Dashboard already
 * renders this via its existing EmptyState (no frontend change needed).
 */
function createGetImprovementQueue(deps = {}) {
  const {
    getProspects: getProspectsFn           = getProspects,
    getScanHistory: getScanHistoryFn       = getScanHistory,
    getPortfolioItems: getPortfolioItemsFn = getPortfolioItems,
    isPortfolioGateEnabled: isEnabledFn    = isPortfolioGateEnabled,
  } = deps;

  return async function getImprovementQueue(req, res, next) {
    try {
      let prospects = await getProspectsFn({});
      if (!prospects.length) return res.json([]);

      if (isEnabledFn() && req.user?.role !== 'operations') {
        if (!req.tenant) return res.json([]);

        const portfolioItems  = await getPortfolioItemsFn(req.tenant.customer.id);
        const portfolioOrgIds = new Set(portfolioItems.map(item => item.organisationId));
        prospects = prospects.filter(p => portfolioOrgIds.has(p.id));
        if (!prospects.length) return res.json([]);
      }

      // Sequential per-prospect to avoid hammering Supabase with N parallel
      // queries. For large cohorts this should be replaced with a batch query.
      const scanHistoriesByProspectId = new Map();
      for (const p of prospects) {
        const history = await getScanHistoryFn(p.website, 1);
        scanHistoriesByProspectId.set(p.id, history[0] || null);
      }

      res.json(buildImprovementQueueItems(prospects, scanHistoriesByProspectId));
    } catch (err) {
      next(err);
    }
  };
}

router.get('/', requireAuth, attachTenant, createGetImprovementQueue());

module.exports = router;
module.exports.createGetImprovementQueue = createGetImprovementQueue;
