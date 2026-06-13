const express = require('express');
const router  = express.Router();
const { randomUUID }            = require('crypto');
const { validateDomain }        = require('../utils/validators');
const { AppError, ValidationError } = require('../utils/errors');
const logger                    = require('../utils/logger');
const { sendConfirmationEmail } = require('../utils/emailService');
const { saveScan, getScanHistory, saveSubmission, getSubmissionById } = require('../services/database');
const { executeScan, getRiskLevel, MAX_POINTS } = require('../services/scanService');
const { generatePDF }           = require('../pdf-generator/generator');
const { adaptScannersForPDF }   = require('../utils/pdfAdapter');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── POST /api/scan ────────────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const { domain } = req.body;

    if (!domain)                  throw new ValidationError('domain is required');
    if (!validateDomain(domain))  throw new ValidationError(`Invalid domain: ${domain}`);

    const { score, riskLevel, scannedAt, totalPoints, maxPoints, scanners, scoreObject } =
      await executeScan(domain);

    const scanRecord = await saveScan(domain, scoreObject, scanners);
    const scanId     = scanRecord.success ? scanRecord.id : null;
    if (!scanRecord.success) {
      logger.error(`Failed to persist scan record for ${domain}: ${scanRecord.error}`);
    } else {
      logger.info(`Scan record stored: ${scanId}`);
    }

    res.json({
      success:   true,
      domain,
      scannedAt,
      score,
      riskLevel,
      totalPoints,
      maxPoints,
      scanners,
      scoreObject,
      scanId,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/scan/history/:domain ─────────────────────────────────────────────
// Returns historical scan records for a domain, ordered newest first.
// Supports future trend charts, score history, and monitoring dashboards.
router.get('/history/:domain', async (req, res, next) => {
  try {
    const domain = String(req.params.domain || '').trim().toLowerCase();
    if (!validateDomain(domain)) throw new ValidationError(`Invalid domain: ${domain}`);

    const limit   = Math.min(Number(req.query.limit) || 100, 500);
    const history = await getScanHistory(domain, limit);

    res.json({ success: true, domain, count: history.length, history });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/scan/submit-gate ────────────────────────────────────────────────
// Captures lead details, fires confirmation email, and links the submission
// to the scan record that preceded it via scanId.
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
      scanScore,    // optional — sent by frontend after scan completes
      scanResults,  // optional — array of scanner objects from new format
      scoreObject,  // optional — v1.0 score object for benchmarking
      scanId,       // optional — id from the scans table for this scan
    } = req.body;

    if (!domain)               throw new ValidationError('Domain is required');
    if (!email)                throw new ValidationError('Email is required');
    if (!EMAIL_RE.test(email)) throw new ValidationError('Invalid email format');

    const trimmedDomain = String(domain).trim().toLowerCase();
    if (!validateDomain(trimmedDomain)) throw new ValidationError(`Invalid domain: ${trimmedDomain}`);

    const parsedConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;
    if (parsedConfidence !== null && (parsedConfidence < 1 || parsedConfidence > 5)) {
      throw new ValidationError('confidence must be between 1 and 5');
    }

    const gateId    = randomUUID();
    const timestamp = new Date().toISOString();

    const submission = {
      gateId,
      domain:        trimmedDomain,
      name:          name         ? String(name).trim()         : '',
      email:         String(email).trim().toLowerCase(),
      firmName:      firmName     ? String(firmName).trim()     : '',
      mainConcern:   mainConcern  ? String(mainConcern).trim()  : '',
      dataIncidents: Boolean(dataIncidents),
      itManagement:  itManagement ? String(itManagement).trim() : '',
      confidence:    parsedConfidence,
      submittedAt:   timestamp,
    };

    const maskedEmail = submission.email.replace(/(.{2})(.*)(@.*)/, '$1***$3');
    logger.info(`Gate submission received: ${submission.domain} | ${maskedEmail} | id: ${gateId}`);

    // ── Supabase persistence ──────────────────────────────────────────────────
    const scannerMap = {};
    if (Array.isArray(scanResults)) {
      scanResults.forEach(s => { scannerMap[s.name] = s.score ?? null; });
    }

    const parsedScanScore = Number(scanScore);
    const normalizedScanScore = Number.isFinite(parsedScanScore) ? parsedScanScore : null;
    const riskLevel = normalizedScanScore !== null ? getRiskLevel(normalizedScanScore) : null;

    const scanDetails = {
      ssl:       scannerMap['SSL/TLS Encryption']       ?? null,
      headers:   scannerMap['Security Headers']         ?? null,
      email_sec: scannerMap['Email Security']           ?? null,
      vulnComp:  scannerMap['Vulnerable Components']    ?? null,
      gdpr:      scannerMap['GDPR / Cookie Compliance'] ?? null,
    };

    const gateFormData = {
      name:          submission.name,
      firmName:      submission.firmName,
      mainConcern:   submission.mainConcern,
      itManagement:  submission.itManagement,
      dataIncidents: submission.dataIncidents,
      confidence:    submission.confidence,
    };

    const dbResult = await saveSubmission(
      submission.email,
      submission.domain,
      normalizedScanScore,
      riskLevel,
      scanDetails,
      gateFormData,
      Array.isArray(scanResults) ? scanResults : null,
      scoreObject ?? null,
      scanId      ?? null,
    );
    if (!dbResult.success) {
      logger.error(`Gate submission DB write failed: ${dbResult.error}`);
    } else {
      logger.info(`Gate submission stored: ${dbResult.id}`);
    }

    // ── Fire-and-forget: confirmation email with PDF link ─────────────────────
    const pdfLink = dbResult.success && process.env.BACKEND_URL
      ? `${process.env.BACKEND_URL}/api/scan/download-pdf/${dbResult.id}`
      : null;
    if (dbResult.success && !process.env.BACKEND_URL) {
      logger.warn('BACKEND_URL not set — PDF link will be omitted from confirmation email');
    }
    void sendConfirmationEmail(submission.email, submission.domain, normalizedScanScore, pdfLink)
      .catch(err => logger.error('Confirmation email failed', err));

    return res.status(200).json({
      success:      true,
      message:      'Check your email for confirmation',
      submissionId: dbResult.success ? dbResult.id : gateId,
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    next(new AppError('Submission failed', 500));
  }
});

// ── GET /api/scan/download-pdf/:submissionId ──────────────────────────────────
router.get('/download-pdf/:submissionId', async (req, res, next) => {
  try {
    const submission = await getSubmissionById(req.params.submissionId);
    if (!submission) return res.status(404).json({ success: false, error: 'Report not found' });

    let rawScanResults, storedScoreObject;
    try {
      const parsed = typeof submission.scan_details === 'string'
        ? JSON.parse(submission.scan_details)
        : submission.scan_details;
      if (Array.isArray(parsed)) {
        rawScanResults    = parsed;
        storedScoreObject = null;
      } else {
        rawScanResults    = parsed?.results ?? [];
        storedScoreObject = parsed?.scoreObject ?? null;
      }
    } catch {
      rawScanResults    = null;
      storedScoreObject = null;
    }

    const results = adaptScannersForPDF(Array.isArray(rawScanResults) ? rawScanResults : []);

    const raw = await generatePDF({
      domain:       submission.domain,
      timestamp:    submission.created_at,
      overallScore: submission.scan_score ?? submission.score ?? 0,
      riskLevel:    (submission.risk_level || 'RED').toLowerCase(),
      results,
      scoreObject:  storedScoreObject,
    });
    const pdf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

    const safeDomain = (submission.domain || 'report').replace(/[^a-zA-Z0-9.-]/g, '-');
    const dateStr    = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeDomain}-security-report-${dateStr}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
