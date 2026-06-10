const express = require('express');
const router = express.Router();
const { generatePDF } = require('../pdf-generator/generator');
const { adaptScannersForPDF } = require('../utils/pdfAdapter');
const { ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

// Normalise riskLevel to the keys generatePDF / RISK_STYLES expects.
// Accepts backend values ('GREEN','AMBER','RED'), already-normalised values
// ('low','medium','critical'), or falls back to the numeric score.
function normaliseRisk(riskLevel, score) {
  const l = String(riskLevel || '').toLowerCase();
  if (l === 'green'  || l === 'low')                    return 'low';
  if (l === 'amber'  || l === 'medium')                 return 'medium';
  if (l === 'red'    || l === 'high' || l === 'critical') return 'critical';
  // score-based fallback
  if (typeof score === 'number') {
    if (score >= 80) return 'low';
    if (score >= 50) return 'medium';
  }
  return 'critical';
}

router.post('/report', async (req, res, next) => {
  try {
    const { domain, timestamp, results, scanners, overallScore, riskLevel } = req.body;

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
    const pdf = await generatePDF({
      domain,
      timestamp,
      results: adaptedResults,
      overallScore,
      riskLevel: riskKey,
    });

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
