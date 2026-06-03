const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');          // Node 18+ built-in — UUID v4 equivalent
const { validateDomain } = require('../utils/validators');
const { AppError, ValidationError } = require('../utils/errors');
const logger = require('../utils/logger');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// In-memory gate submission store.
// Phase 2: replace with a database insert.
// Data does not persist across server restarts.
const gateSubmissions = new Map();

const sslCheck = require('../scanners/ssl-check');
const headersCheck = require('../scanners/headers-check');
const dnsCheck = require('../scanners/dns-check');
// const portScan = require('../scanners/port-scan'); // DISABLED: Port scanning removed from free tier (paid feature)
const subdomains = require('../scanners/subdomains');
const techDetect = require('../scanners/tech-detect');
const gdprCheck = require('../scanners/gdpr-check');

router.post('/', async (req, res, next) => {
  try {
    const { domain } = req.body;

    if (!domain) {
      throw new ValidationError('domain is required');
    }
    if (!validateDomain(domain)) {
      throw new ValidationError(`Invalid domain: ${domain}`);
    }

    logger.info(`Scan started for ${domain}`);

    const [ssl, headers, dns, subs, tech, gdpr] = await Promise.allSettled([
      sslCheck(domain),
      headersCheck(domain),
      dnsCheck(domain),
      // portScan(domain), // DISABLED
      subdomains(domain),
      techDetect(domain),
      gdprCheck(domain),
    ]);

    const results = {
      ssl: ssl.status === 'fulfilled' ? ssl.value : { module: 'ssl', status: 'error', error: ssl.reason?.message },
      headers: headers.status === 'fulfilled' ? headers.value : { module: 'headers', status: 'error', error: headers.reason?.message },
      dns: dns.status === 'fulfilled' ? dns.value : { module: 'dns', status: 'error', error: dns.reason?.message },
      // ports: ports.status === 'fulfilled' ? ports.value : { module: 'ports', status: 'error', error: ports.reason?.message }, // DISABLED
      subdomains: subs.status === 'fulfilled' ? subs.value : { module: 'subdomains', status: 'error', error: subs.reason?.message },
      tech: tech.status === 'fulfilled' ? tech.value : { module: 'tech', status: 'error', error: tech.reason?.message },
      gdpr: gdpr.status === 'fulfilled' ? gdpr.value : { module: 'gdpr', status: 'error', error: gdpr.reason?.message },
    };

    logger.info(`Scan complete for ${domain}`);

    res.json({
      success: true,
      domain,
      scannedAt: new Date().toISOString(),
      results,
      pdfUrl: null,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/scan/submit-gate ────────────────────────────────────────────────
// Captures lead details before showing full results.
// Validates, stores in memory, and returns a gateId for the session.
router.post('/submit-gate', async (req, res, next) => {
  try {
    const {
      domain,
      name,
      email,
      firmName,
      mainConcern,
      dataIncidents,
      itManagement,
      confidence,
    } = req.body;

    if (!domain)                    throw new ValidationError('Domain is required');
    if (!email)                     throw new ValidationError('Email is required');
    if (!EMAIL_RE.test(email))      throw new ValidationError('Invalid email format');

    const gateId = randomUUID();

    const submission = {
      gateId,
      domain:        String(domain).trim(),
      name:          name        ? String(name).trim()        : '',
      email:         String(email).trim().toLowerCase(),
      firmName:      firmName    ? String(firmName).trim()    : '',
      mainConcern:   mainConcern ? String(mainConcern).trim() : '',
      dataIncidents: Boolean(dataIncidents),
      itManagement:  itManagement ? String(itManagement).trim() : '',
      confidence:    Number.isFinite(Number(confidence)) ? Number(confidence) : null,
      submittedAt:   new Date().toISOString(),
    };

    gateSubmissions.set(gateId, submission);

    console.log(`[GATE] Submission: ${submission.email} | ${submission.domain} | ${submission.mainConcern}`);

    return res.status(200).json({
      success: true,
      message: 'Thank you for your details',
      gateId,
    });
  } catch (err) {
    // Pass ValidationErrors (400) through the global handler unchanged;
    // wrap anything else in a plain 500 so the message stays controlled.
    if (err instanceof AppError) return next(err);
    next(new AppError('Submission failed', 500));
  }
});

module.exports = router;
