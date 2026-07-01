const express = require('express');
const router  = express.Router();
const logger  = require('../../infra/utils/logger');
const { getProspects, getScanHistory } = require('../../infra/database');

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

// ── GET /api/improvement-queue ─────────────────────────────────────────────────
// Portfolio-wide improvement queue. Fetches the latest scan for every prospect
// and aggregates failing / warning checks across all organisations.
// Returns ImprovementQueueItemDTO[].
router.get('/', async (req, res, next) => {
  try {
    const prospects = await getProspects({});
    if (!prospects.length) return res.json([]);

    const items = [];

    // Sequential per-prospect to avoid hammering Supabase with N parallel queries.
    // For large cohorts this should be replaced with a batch query.
    for (const p of prospects) {
      const history = await getScanHistory(p.website, 1);
      const scan    = history[0] || null;
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
    items.sort((a, b) =>
      a.priority === 'high' && b.priority !== 'high' ? -1
      : b.priority === 'high' && a.priority !== 'high' ? 1
      : 0
    );

    res.json(items);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
