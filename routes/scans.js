const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');
const { getScans, getScanWithOrg } = require('../services/database');

// ── GET /api/scans ────────────────────────────────────────────────────────────
// Returns ScanRecordDTO[] (no wrapper). Filtering via query params:
//   ?domain=   filter to a specific domain
//   ?riskBand= filter by risk band label
//   ?since=    ISO 8601 date — only scans on or after this date
//   ?search=   free-text across domain (server-side filtering)
//   ?sort=asc  reverse chronological (default is newest first)
router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.domain)   filter.domain   = String(req.query.domain).trim();
    if (req.query.riskBand) filter.riskBand = String(req.query.riskBand).trim();
    if (req.query.since)    filter.since    = String(req.query.since).trim();

    let results = await getScans(filter);

    // Free-text search across domain and org name (done post-fetch since Supabase
    // ilike on joined columns is cumbersome)
    if (req.query.search) {
      const q = String(req.query.search).trim().toLowerCase();
      results = results.filter(r =>
        r.domain?.includes(q) ||
        (r.organisation_name || '').toLowerCase().includes(q)
      );
    }

    if (req.query.sort === 'asc') {
      results = [...results].sort(
        (a, b) => new Date(a.scanned_at).getTime() - new Date(b.scanned_at).getTime()
      );
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/scans/:id ────────────────────────────────────────────────────────
// Returns a single ScanRecordDTO or 404.
router.get('/:id', async (req, res, next) => {
  try {
    const scan = await getScanWithOrg(req.params.id);
    if (!scan) return res.status(404).json({ error: 'Scan not found' });
    res.json(scan);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
