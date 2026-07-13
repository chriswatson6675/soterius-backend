const express = require('express');
const router = express.Router();
const { generatePDF } = require('../pdf-generator/generator');
const { adaptScannersForPDF } = require('../../infra/utils/pdfAdapter');
const { ValidationError, AppError } = require('../../infra/utils/errors');
const logger = require('../../infra/utils/logger');
const derivation = require('../services/scan-derivation-service');
const { getScanById } = require('../../infra/database');

// Maps a canonical risk label (always derived server-side — never client
// input, see below) onto the five-band keys the PDF generator expects.
function riskLabelToPdfKey(riskLevel) {
  const l = String(riskLevel || '').toLowerCase().replace(/\s+/g, '');
  if (l === 'excellent')     return 'excellent';
  if (l === 'good')          return 'good';
  if (l === 'moderaterisk')  return 'moderate';
  if (l === 'highrisk')      return 'high';
  return 'critical';
}

// POST /api/report — body: { scanId }
//
// ENG-011 §3 / ENG-012 §1.2 / §2 item 1 (T3.1, ENG-013 WP3) remediation: this
// endpoint previously accepted overallScore/riskLevel/scoreObject/results/
// scanners directly from the request body and rendered them into a PDF with
// no server-side re-derivation at all — resolveRiskLevel() even preferred a
// caller-supplied riskLevel outright over any score-based derivation. That
// was the single most severe finding in ENG-011's convergence audit.
//
// Every trust-bearing field is now derived server-side from the persisted
// scanner_results — the evidence of record for the referenced scan
// (infra/database.js's own contract: score/risk-band are "a NON-AUTHORITATIVE
// DERIVED CACHE... recomputable at any time from scanner_results"). A caller
// can now only choose WHICH already-persisted scan to render; it can no
// longer influence WHAT the rendered result says. No new write occurs here —
// this route only reads an existing, immutable `scans` row (append-only
// invariant, CLAUDE.md, untouched).
function createPostReport(getScanByIdFn = getScanById, generatePDFFn = generatePDF) {
  return async function postReport(req, res, next) {
    try {
      const { scanId } = req.body;
      if (!scanId) throw new ValidationError('scanId is required');

      const scan = await getScanByIdFn(scanId);
      if (!scan) return res.status(404).json({ success: false, error: 'Scan not found' });
      if (!Array.isArray(scan.scanner_results)) {
        throw new AppError('Scan record has no scanner results to derive from', 500);
      }

      logger.info(`PDF report requested for scan ${scanId} (${scan.domain})`);

      // Dispatches on scan.scoring_version (ADR-SYS-011) — legacy-tier rows
      // re-derive via the historical engine, trustprofile-v1 rows re-present
      // their already-computed Observatory derivation. Never assumes which
      // tier produced this row.
      const derived = derivation.deriveScanPresentationForRow(scan);
      const adaptedResults = adaptScannersForPDF(derived.scanners);

      const raw = await generatePDFFn({
        domain:       scan.domain,
        timestamp:    scan.scanned_at,
        results:      adaptedResults,
        overallScore: derived.score,
        riskLevel:    riskLabelToPdfKey(derived.riskLevel),
        scoreObject:  derived.scoreObject,
      });
      // Puppeteer 22+ returns Uint8Array; Express 4 res.send() JSON-stringifies
      // anything that isn't a Buffer, so we must convert explicitly.
      const pdf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

      const safeDomain = String(scan.domain).replace(/[^a-zA-Z0-9.-]/g, '-');
      const dateStr = new Date().toISOString().split('T')[0];
      const filename = `${safeDomain}-security-report-${dateStr}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', pdf.length);
      res.send(pdf);
    } catch (err) {
      next(err);
    }
  };
}

router.post('/report', createPostReport());

module.exports = router;
module.exports.createPostReport = createPostReport;
module.exports.riskLabelToPdfKey = riskLabelToPdfKey;
