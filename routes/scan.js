const express = require('express');
const router  = express.Router();
const { randomUUID }            = require('crypto');
const { validateDomain }        = require('../utils/validators');
const { AppError, ValidationError } = require('../utils/errors');
const logger                    = require('../utils/logger');
const { sendConfirmationEmail } = require('../utils/emailService');
const { appendSubmissionToCSV } = require('../utils/csvExporter');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// In-memory gate submission store (no persistence across restarts)
const gateSubmissions = new Map();

const sslCheck       = require('../scanners/ssl-check');
const headersCheck   = require('../scanners/headers-check');
const emailSecurity  = require('../scanners/dns-check');
const vulnComponents = require('../scanners/tech-detect');
const gdprCheck      = require('../scanners/gdpr-check');

const SCANNERS = [
  { key: 'ssl',      name: 'SSL/TLS Encryption',      fn: sslCheck,       expectedChecks: 4, pts: { PASS: 10, WARNING:  5, FAIL: 0 } }, // max 40
  { key: 'email',    name: 'Email Security',           fn: emailSecurity,  expectedChecks: 3, pts: { PASS:  8, WARNING:  4, FAIL: 0 } }, // max 24
  { key: 'headers',  name: 'Security Headers',         fn: headersCheck,   expectedChecks: 5, pts: { PASS:  6, WARNING:  3, FAIL: 0 } }, // max 30
  { key: 'vulnComp', name: 'Vulnerable Components',    fn: vulnComponents, expectedChecks: 3, pts: { PASS:  4, WARNING:  2, FAIL: 0 } }, // max 12
  { key: 'gdpr',     name: 'GDPR / Cookie Compliance', fn: gdprCheck,      expectedChecks: 6, pts: { PASS:  2, WARNING:  1, FAIL: 0 } }, // max 12
];

const MAX_POINTS = 118; // SSL(40)+Email(24)+Headers(30)+Vuln(12)+GDPR(12)

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

    gateSubmissions.set(gateId, submission);

    console.log(`[GATE] Submission received for: ${submission.domain} | email: ${submission.email} | id: ${gateId}`);

    // ── Fire-and-forget: email confirmation ──────────────────────────────────
    console.log(`[GATE] About to send confirmation email to: ${submission.email}`);
    sendConfirmationEmail(submission.email, submission.domain, scanScore ?? null);
    console.log(`[GATE] Email function called (fire-and-forget — check [EMAIL] logs for result)`);

    // ── Fire-and-forget: CSV export ──────────────────────────────────────────
    // scanResults is now an array of { name, score, checks[] }
    const scannerMap = {};
    if (Array.isArray(scanResults)) {
      scanResults.forEach(s => { scannerMap[s.name] = s.score ?? ''; });
    }

    appendSubmissionToCSV({
      submissionId:  gateId,
      timestamp,
      domain:        submission.domain,
      email:         submission.email,
      name:          submission.name,
      firmName:      submission.firmName,
      mainConcern:   submission.mainConcern,
      itManagement:  submission.itManagement,
      dataIncidents: submission.dataIncidents ? 'Yes' : 'No',
      confidence:    submission.confidence ?? '',
      scanScore:     typeof scanScore === 'number' ? scanScore : '',
      ssl:           scannerMap['SSL/TLS Encryption']      ?? '',
      headers:       scannerMap['Security Headers']        ?? '',
      email_sec:     scannerMap['Email Security']          ?? '',
      vulnComp:      scannerMap['Vulnerable Components']   ?? '',
      gdpr:          scannerMap['GDPR / Cookie Compliance'] ?? '',
    }).catch(err => logger.error(`[GATE] CSV write failed: ${err.message}`));

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

module.exports = router;
