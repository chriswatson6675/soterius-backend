const express = require('express');
const router = express.Router();
const { generatePDF } = require('../pdf-generator/generator');
const { ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

router.post('/report', async (req, res, next) => {
  try {
    const { domain, timestamp, results, overallScore, riskLevel } = req.body;

    if (!domain) throw new ValidationError('domain is required');
    if (!results || typeof results !== 'object') throw new ValidationError('results object is required');

    logger.info(`PDF report requested for ${domain}`);

    const pdf = await generatePDF({ domain, timestamp, results, overallScore, riskLevel });

    const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, '-');
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `${safeDomain}-gdpr-report-${dateStr}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
