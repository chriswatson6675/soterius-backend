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

function getRiskLevel(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Moderate Risk';
  if (score >= 40) return 'High Risk';
  return 'Critical Risk';
}

function getRiskBand(pct) {
  if (pct >= 90) return 'Excellent';
  if (pct >= 75) return 'Good';
  if (pct >= 60) return 'Moderate Risk';
  if (pct >= 40) return 'High Risk';
  return 'Critical Risk';
}


const sslCheck       = require('../scanners/ssl-check');
const headersCheck   = require('../scanners/headers-check');
const emailSecurity  = require('../scanners/dns-check');
const vulnComponents = require('../scanners/tech-detect');
const gdprCheck      = require('../scanners/gdpr-check');

// maxPoints reflects v1.0 methodology:
//   ssl:      4 checks × 10pts = 40
//   email:    SPF(8) + DKIM(8) + DMARC(40) = 56   (DMARC uses check.points)
//   headers:  HSTS(15) + CSP(13) + XFO(10) + XCTO(8) + RP(4) = 50  (all use check.points)
//   vulnComp: CVE(40) + Disclosure(4) + Libraries(4) = 48  (CVE uses check.points)
//   gdpr:     6 checks × 2pts = 12
const SCANNERS = [
  { key: 'ssl',      name: 'SSL/TLS Encryption',      fn: sslCheck,       maxPoints: 40,  pts: { PASS: 10, WARNING:  5, FAIL: 0 } },
  { key: 'email',    name: 'Email Security',           fn: emailSecurity,  maxPoints: 56,  pts: { PASS:  8, WARNING:  4, FAIL: 0 } },
  { key: 'headers',  name: 'Security Headers',         fn: headersCheck,   maxPoints: 50,  pts: null },
  { key: 'vulnComp', name: 'Vulnerable Components',    fn: vulnComponents, maxPoints: 48,  pts: { PASS:  4, WARNING:  2, FAIL: 0 } },
  { key: 'gdpr',     name: 'GDPR / Cookie Compliance', fn: gdprCheck,      maxPoints: 12,  pts: { PASS:  2, WARNING:  1, FAIL: 0 } },
];

const MAX_POINTS = SCANNERS.reduce((sum, def) => sum + def.maxPoints, 0); // 206

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

      const maxPts    = def.maxPoints;
      const earnedPts = checks.reduce((sum, c) => {
        if (typeof c.points === 'number') return sum + c.points;
        const status = String(c.status || '').toUpperCase();
        return sum + (def.pts ? (def.pts[status] ?? 0) : 0);
      }, 0);

      return { def, checks, maxPts, earnedPts };
    });

    const totalPoints = interim.reduce((sum, r) => sum + r.earnedPts, 0);
    const score       = Math.round((totalPoints / MAX_POINTS) * 100);
    const riskLevel   = getRiskLevel(score);

    const categoryBreakdown = {};
    const scanners = interim.map(({ def, checks, maxPts, earnedPts }) => {
      const catPct    = maxPts > 0 ? Math.round((earnedPts / maxPts) * 100) : 0;
      const catRating = getRiskBand(catPct);
      categoryBreakdown[def.key] = { achieved: earnedPts, maximum: maxPts, percentage: catPct, rating: catRating };
      return { name: def.name, score: catPct, rating: catRating, checks };
    });

    const scoreObject = {
      achievedPoints:    totalPoints,
      totalMaximum:      MAX_POINTS,
      percentage:        score,
      riskBand:          riskLevel,
      categoryBreakdown,
      timestamp:         new Date().toISOString(),
      scoringVersion:    'v1.0',
    };

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
      scoreObject,
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
      scoreObject,  // optional — v1.0 score object for benchmarking
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
