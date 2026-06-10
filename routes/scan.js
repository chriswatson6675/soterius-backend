const express = require('express');
const router  = express.Router();
const { randomUUID }            = require('crypto');
const { validateDomain }        = require('../utils/validators');
const { AppError, ValidationError } = require('../utils/errors');
const logger                    = require('../utils/logger');
const { sendConfirmationEmail } = require('../utils/emailService');
const { saveSubmission, getSubmissionById } = require('../services/database');
const { generatePDF }           = require('../pdf-generator/generator');
const { adaptScannersForPDF }   = require('../utils/pdfAdapter');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


const sslCheck       = require('../scanners/ssl-check');
const headersCheck   = require('../scanners/headers-check');
const emailSecurity  = require('../scanners/dns-check');
const vulnComponents = require('../scanners/tech-detect');
const gdprCheck      = require('../scanners/gdpr-check');

const SCANNERS = [
  { key: 'ssl',      name: 'SSL/TLS Encryption',      fn: sslCheck,       expectedChecks: 4, pts: { PASS: 10, WARNING:  5, FAIL: 0 } }, // max 40
  { key: 'email',    name: 'Email Security',           fn: emailSecurity,  expectedChecks: 3, pts: { PASS:  8, WARNING:  4, FAIL: 0 } }, // max 24
  { key: 'headers',  name: 'Security Headers',         fn: headersCheck,   expectedChecks: 4, pts: { PASS:  5, WARNING:  3, FAIL: 0 } }, // max 20
  { key: 'vulnComp', name: 'Vulnerable Components',    fn: vulnComponents, expectedChecks: 3, pts: { PASS:  4, WARNING:  2, FAIL: 0 } }, // max 12
  { key: 'gdpr',     name: 'GDPR / Cookie Compliance', fn: gdprCheck,      expectedChecks: 6, pts: { PASS:  2, WARNING:  1, FAIL: 0 } }, // max 12
];

const MAX_POINTS = 108; // SSL(40)+Email(24)+Headers(20)+Vuln(12)+GDPR(12)

// ── POST /api/scan ────────────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const { domain } = req.body;

    if (!domain)             throw new ValidationError('domain is required');
    if (!validateDomain(domain)) throw new ValidationError(`Invalid domain: ${domain}`);

    logger.info(`Scan started for ${domain}`);

    const raw = await Promise.allSettled(SCANNERS.map(s => s.fn(domain)));

    const interim = SCANNERS.map((def, i) => {
      const checks = raw[i].status === 'fulfilled'
        ? raw[i].value
        : [{ name: 'Scanner error', status: 'FAIL', details: raw[i].reason?.message || 'Unknown error', timeToFix: 'N/A' }];

      const maxPts    = def.expectedChecks * def.pts.PASS;
      const earnedPts = checks.reduce((sum, c) => sum + (def.pts[c.status] ?? 0), 0);

      return { def, checks, maxPts, earnedPts };
    });

    const totalPoints = interim.reduce((sum, r) => sum + r.earnedPts, 0);
    const score       = Math.round((totalPoints / MAX_POINTS) * 100);
    const riskLevel   = score >= 80 ? 'GREEN' : score >= 50 ? 'AMBER' : 'RED';

    const scanners = interim.map(({ def, checks, maxPts, earnedPts }) => ({
      name:  def.name,
      score: maxPts > 0 ? Math.round((earnedPts / maxPts) * 100) : 0,
      checks,
    }));

    logger.info(`Scan complete for ${domain} — score: ${score} (${riskLevel})`);

    res.json({
      success:     true,
      domain,
      scannedAt:   new Date().toISOString(),
      score,
      riskLevel,
      totalPoints,
      maxPoints:   MAX_POINTS,
      scanners,
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/scan/submit-gate ────────────────────────────────────────────────
// Captures lead details, fires confirmation email + CSV export (both non-blocking),
// and returns immediately so the UI doesn't wait on SMTP.
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
    } = req.body;

    if (!domain)               throw new ValidationError('Domain is required');
    if (!email)                throw new ValidationError('Email is required');
    if (!EMAIL_RE.test(email)) throw new ValidationError('Invalid email format');

    const gateId    = randomUUID();
    const timestamp = new Date().toISOString();

    const submission = {
      gateId,
      domain:        String(domain).trim(),
      name:          name         ? String(name).trim()         : '',
      email:         String(email).trim().toLowerCase(),
      firmName:      firmName     ? String(firmName).trim()     : '',
      mainConcern:   mainConcern  ? String(mainConcern).trim()  : '',
      dataIncidents: Boolean(dataIncidents),
      itManagement:  itManagement ? String(itManagement).trim() : '',
      confidence:    Number.isFinite(Number(confidence)) ? Number(confidence) : null,
      submittedAt:   timestamp,
    };

    console.log(`[GATE] Submission received for: ${submission.domain} | email: ${submission.email} | id: ${gateId}`);

    // ── Supabase persistence ──────────────────────────────────────────────────
    const scannerMap = {};
    if (Array.isArray(scanResults)) {
      scanResults.forEach(s => { scannerMap[s.name] = s.score ?? null; });
    }

    const riskLevel = typeof scanScore === 'number'
      ? (scanScore >= 80 ? 'GREEN' : scanScore >= 50 ? 'AMBER' : 'RED')
      : null;

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
      typeof scanScore === 'number' ? scanScore : null,
      riskLevel,
      scanDetails,
      gateFormData,
      Array.isArray(scanResults) ? scanResults : null,
    );
    if (!dbResult.success) {
      console.log(`[GATE] Supabase write FAILED: ${dbResult.error}`);
    } else {
      console.log(`[GATE] Supabase write OK — id: ${dbResult.id}`);
    }

    // ── Fire-and-forget: confirmation email with PDF link ─────────────────────
    const pdfLink = dbResult.success
      ? `${process.env.BACKEND_URL}/api/scan/download-pdf/${dbResult.id}`
      : null;
    sendConfirmationEmail(submission.email, submission.domain, scanScore ?? null, pdfLink);

    return res.status(200).json({
      success:      true,
      message:      'Check your email for confirmation',
      submissionId: gateId,
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

    let rawScanResults;
    try {
      rawScanResults = typeof submission.scan_details === 'string'
        ? JSON.parse(submission.scan_details)
        : submission.scan_details;
    } catch {
      rawScanResults = null;
    }

    const results = adaptScannersForPDF(Array.isArray(rawScanResults) ? rawScanResults : []);

    const pdf = await generatePDF({
      domain:       submission.domain,
      timestamp:    submission.created_at,
      overallScore: submission.scan_score ?? submission.score ?? 0,
      riskLevel:    (submission.risk_level || 'medium').toLowerCase(),
      results,
    });

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
