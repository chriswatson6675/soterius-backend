const express = require('express');
const router  = express.Router();
const logger  = require('../infra/utils/logger');
const { ValidationError } = require('../infra/utils/errors');
const {
  getProspects, getProspectById, getScanHistory, getLatestScansByDomains,
} = require('../infra/database');

// ── SLG-014 scanner → category mapping ──────────────────────────────────────
// Maps the v1.0 scanner keys to the closest SLG-014 trust category.
// Categories without a direct scanner remain at "Moderate Risk" (no data).
// Changes here require a scoring-version bump + DECISIONS.md entry.

const SCANNER_TO_CATEGORY = {
  email:    'A', // Email Trust (SPF / DKIM / DMARC)
  ssl:      'D', // TLS & Certificate Trust
  headers:  'C', // Control Transparency Trust (security headers = control publication)
  vulnComp: 'F', // Infrastructure Trust (server & component exposure)
  gdpr:     'H', // Governance & Accountability Trust (cookie consent / privacy policy)
};

const CATEGORY_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const DEFAULT_BAND   = 'Moderate Risk'; // shown for categories with no scanner coverage

// ── Helpers ──────────────────────────────────────────────────────────────────

function deriveTrustPosture(latestScan) {
  if (!latestScan || !latestScan.score_object) {
    return {
      overallBand: DEFAULT_BAND,
      categories: CATEGORY_CODES.map(code => ({ code, band: DEFAULT_BAND })),
    };
  }

  const breakdown = latestScan.score_object.categoryBreakdown ?? {};
  const bandByKey = {};
  for (const [key, data] of Object.entries(breakdown)) {
    bandByKey[key] = data.rating;
  }

  const categories = CATEGORY_CODES.map(code => {
    const scannerKey = Object.entries(SCANNER_TO_CATEGORY).find(([, c]) => c === code)?.[0];
    return { code, band: (scannerKey && bandByKey[scannerKey]) || DEFAULT_BAND };
  });

  return { overallBand: latestScan.risk_band || DEFAULT_BAND, categories };
}

function toOrganisationDTO(prospect, latestScan) {
  return {
    id:     prospect.id,
    name:   prospect.firm_name,
    domain: prospect.website,
    sector: prospect.sector || 'unknown',
    cohort: prospect.source  || null,
    identifiers: {
      frn:                prospect.source === 'fca-registry' ? prospect.source_reference : undefined,
      sraId:              prospect.source === 'sra-registry' ? prospect.source_reference : undefined,
      companiesHouseNumber: undefined, // not yet in prospects table
    },
    registryStatus:      'active',
    latestObservatoryRun: latestScan ? {
      id:               latestScan.id,
      completedAt:      latestScan.scanned_at,
      status:           'complete',
      signalsCollected: (latestScan.scanner_results ?? []).reduce((s, sc) => s + (sc.checks?.length ?? 0), 0),
      signalsTotal:     (latestScan.scanner_results ?? []).reduce((s, sc) => s + (sc.checks?.length ?? 0), 0),
    } : null,
    lastEvidenceAt: prospect.last_scanned || null,
    trustPosture:   deriveTrustPosture(latestScan),
  };
}

// Scanner name → key mapping (matches scanService.js SCANNERS)
const SCANNER_NAME_TO_KEY = {
  'SSL/TLS Encryption':     'ssl',
  'Email Security':         'email',
  'Security Headers':       'headers',
  'Vulnerable Components':  'vulnComp',
  'GDPR / Cookie Compliance': 'gdpr',
};

function deriveSignals(latestScan) {
  if (!latestScan || !Array.isArray(latestScan.scanner_results)) return [];

  const signals = [];
  for (const scanner of latestScan.scanner_results) {
    const key          = SCANNER_NAME_TO_KEY[scanner.name];
    const categoryCode = (key && SCANNER_TO_CATEGORY[key]) || 'F';

    for (let i = 0; i < (scanner.checks || []).length; i++) {
      const check  = scanner.checks[i];
      const status = check.status === 'PASS' ? 'pass'
                   : check.status === 'WARNING' ? 'warning'
                   : 'fail';

      signals.push({
        id:                  `SOT-SCAN-${(key || 'UNK').toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
        name:                check.name,
        categoryCode,
        status,
        latestObservedValue: check.details || '',
        latestObservedAt:    latestScan.scanned_at,
        trend:               'unknown',
        evidenceCount:       1,
        collector:           scanner.name,
      });
    }
  }
  return signals;
}

function deriveTimeline(scanHistory) {
  if (!Array.isArray(scanHistory)) return [];
  // Oldest first for diff-based descriptions
  const chronological = [...scanHistory].reverse();
  return chronological.map((scan, idx) => {
    const prev = chronological[idx - 1];
    const direction = !prev ? 'initial'
      : scan.overall_score > prev.overall_score ? 'improved'
      : scan.overall_score < prev.overall_score ? 'declined'
      : 'stable';

    const description = !prev
      ? `Initial scan: ${scan.overall_score}% (${scan.risk_band})`
      : `Score ${direction} from ${prev.overall_score}% to ${scan.overall_score}% (${scan.risk_band})`;

    return {
      id:          `tl-${scan.id}`,
      occurredAt:  scan.scanned_at,
      signalId:    'SOT-SCAN-OVERALL',
      signalName:  'Overall Trust Score',
      categoryCode: 'I',
      changeType:  direction === 'initial' ? 'appeared' : 'changed',
      description,
      evidenceId:  scan.id,
    };
  }).reverse(); // newest first for display
}

function deriveImprovementQueue(prospect, latestScan) {
  if (!latestScan || !Array.isArray(latestScan.scanner_results)) return [];

  const items = [];
  for (const scanner of latestScan.scanner_results) {
    const key          = SCANNER_NAME_TO_KEY[scanner.name];
    const categoryCode = (key && SCANNER_TO_CATEGORY[key]) || 'F';

    for (let i = 0; i < (scanner.checks || []).length; i++) {
      const check = scanner.checks[i];
      if (check.status === 'PASS') continue;

      items.push({
        id:                    `iq-${latestScan.id}-${key || 'unk'}-${i}`,
        organisationId:        prospect.id,
        organisationName:      prospect.firm_name,
        organisationDomain:    prospect.website,
        signalId:              `SOT-SCAN-${(key || 'UNK').toUpperCase()}-${String(i + 1).padStart(3, '0')}`,
        signalName:            check.name,
        categoryCode,
        priority:              check.status === 'FAIL' ? 'high' : 'medium',
        observableIssue:       check.details || check.name,
        whyItMatters:          `Affects ${scanner.name} trust posture.`,
        expectedImpactBand:    'Good',
        implementationStatus:  'open',
        supportingEvidenceIds: [latestScan.id],
        raisedAt:              latestScan.scanned_at,
      });
    }
  }
  // FAILs first, then WARNINGs
  return items.sort((a, b) =>
    a.priority === 'high' && b.priority !== 'high' ? -1
    : b.priority === 'high' && a.priority !== 'high' ? 1
    : 0
  );
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/organisations/search?q=
// Returns OrganisationSearchResultDTO[] directly (no wrapper).
router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 2) return res.json([]);

    const all = await getProspects({});

    // Filter locally — prospect count is in the hundreds not millions
    const matched = all.filter(p =>
      p.firm_name?.toLowerCase().includes(q) ||
      p.website?.toLowerCase().includes(q)   ||
      p.source_reference?.toLowerCase().includes(q)
    ).slice(0, 50);

    if (!matched.length) return res.json([]);

    // Batch-fetch latest scan band for each matched org
    const latestScans = await getLatestScansByDomains(matched.map(p => p.website));

    const results = matched.map(p => {
      const matchedOn = [];
      if (p.firm_name?.toLowerCase().includes(q))       matchedOn.push('name');
      if (p.website?.toLowerCase().includes(q))         matchedOn.push('domain');
      if (p.source_reference?.toLowerCase().includes(q)) {
        if (p.source === 'fca-registry')  matchedOn.push('frn');
        else if (p.source === 'sra-registry') matchedOn.push('sraId');
        else matchedOn.push('companiesHouseNumber');
      }

      const latestScan = latestScans[p.website] || null;
      return {
        id:      p.id,
        name:    p.firm_name,
        domain:  p.website,
        sector:  p.sector || 'unknown',
        identifiers: {
          frn:   p.source === 'fca-registry'  ? p.source_reference : undefined,
          sraId: p.source === 'sra-registry'  ? p.source_reference : undefined,
        },
        matchedOn,
        overallBand: latestScan?.risk_band || DEFAULT_BAND,
      };
    });

    res.json(results);
  } catch (err) {
    next(err);
  }
});

// GET /api/organisations/:id
// Returns OrganisationDTO directly.
router.get('/:id', async (req, res, next) => {
  try {
    const prospect = await getProspectById(req.params.id);
    if (!prospect) return res.status(404).json({ error: 'Organisation not found' });

    const history   = await getScanHistory(prospect.website, 1);
    const latestScan = history[0] || null;

    res.json(toOrganisationDTO(prospect, latestScan));
  } catch (err) {
    next(err);
  }
});

// GET /api/organisations/:id/signals
// Returns SignalDTO[] directly.
router.get('/:id/signals', async (req, res, next) => {
  try {
    const prospect = await getProspectById(req.params.id);
    if (!prospect) return res.status(404).json({ error: 'Organisation not found' });

    const history   = await getScanHistory(prospect.website, 1);
    const latestScan = history[0] || null;

    res.json(deriveSignals(latestScan));
  } catch (err) {
    next(err);
  }
});

// GET /api/organisations/:id/timeline
// Returns TimelineEventDTO[] directly.
router.get('/:id/timeline', async (req, res, next) => {
  try {
    const prospect = await getProspectById(req.params.id);
    if (!prospect) return res.status(404).json({ error: 'Organisation not found' });

    const history = await getScanHistory(prospect.website, 50);
    res.json(deriveTimeline(history));
  } catch (err) {
    next(err);
  }
});

// GET /api/organisations/:id/improvement-queue
// Returns ImprovementQueueItemDTO[] directly.
router.get('/:id/improvement-queue', async (req, res, next) => {
  try {
    const prospect = await getProspectById(req.params.id);
    if (!prospect) return res.status(404).json({ error: 'Organisation not found' });

    const history   = await getScanHistory(prospect.website, 1);
    const latestScan = history[0] || null;

    res.json(deriveImprovementQueue(prospect, latestScan));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
