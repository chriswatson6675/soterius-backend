const express = require('express');
const router = express.Router();
const { generatePDF } = require('../pdf-generator/generator');
const { adaptScannersForPDF } = require('../utils/pdfAdapter');
const { ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

// Normalise riskLevel to the five-band keys the generator expects.
function normaliseRisk(riskLevel, score) {
  const l = String(riskLevel || '').toLowerCase().replace(/\s+/g, '');
  if (l === 'excellent')                                        return 'excellent';
  if (l === 'good' || l === 'green' || l === 'low')            return 'good';
  if (l === 'moderaterisk' || l === 'moderate')                return 'moderate';
  if (l === 'highrisk' || l === 'high' || l === 'amber' || l === 'medium') return 'high';
  if (l === 'criticalrisk' || l === 'critical' || l === 'red') return 'critical';
  // score-based fallback
  if (typeof score === 'number') {
    if (score >= 90) return 'excellent';
    if (score >= 75) return 'good';
    if (score >= 60) return 'moderate';
    if (score >= 40) return 'high';
  }
  return 'critical';
}

router.post('/report', async (req, res, next) => {
  try {
    const { domain, timestamp, results, scanners, overallScore, riskLevel, scoreObject } = req.body;

    if (!domain) throw new ValidationError('domain is required');

    // Accept either the legacy `results` object or the new `scanners` array
    // (frontend sends scanners; older callers may send results directly)
    const adaptedResults = results
      || (Array.isArray(scanners) ? adaptScannersForPDF(scanners) : null);

    if (!adaptedResults || typeof adaptedResults !== 'object') {
      throw new ValidationError('Either a results object or a scanners array is required');
    }

    logger.info(`PDF report requested for ${domain}`);

    const riskKey = normaliseRisk(riskLevel, overallScore);
    const raw = await generatePDF({
      domain,
      timestamp,
      results: adaptedResults,
      overallScore,
      riskLevel: riskKey,
      scoreObject,
    });
    // Puppeteer 22+ returns Uint8Array; Express 4 res.send() JSON-stringifies
    // anything that isn't a Buffer, so we must convert explicitly.
    const pdf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

    const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, '-');
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `${safeDomain}-security-report-${dateStr}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
