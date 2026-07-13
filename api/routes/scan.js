const express = require('express');
const router  = express.Router();
const { randomUUID }            = require('crypto');
const { validateDomain }        = require('../../infra/utils/validators');
const { AppError, ValidationError } = require('../../infra/utils/errors');
const logger                    = require('../../infra/utils/logger');
const { sendConfirmationEmail } = require('../../infra/utils/emailService');
const { saveScan, getScanHistory, saveSubmission, getSubmissionById, getScanById } = require('../../infra/database');
const { executeTrustProfileScan } = require('../services/trustprofile-scan-service');
const derivation = require('../services/scan-derivation-service');
const { generatePDF }           = require('../pdf-generator/generator');
const { adaptScannersForPDF }   = require('../../infra/utils/pdfAdapter');
const { createPublicScanRateLimit } = require('../middleware/publicScanRateLimit');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Per-IP rate limiting (ENG-028 C-1) ──────────────────────────────────────
//
// This router had no abuse protection at all — unlike POST /api/public-scan,
// which ENG-010/ENG-013 already gated behind its own composed protection
// layer (see public-scan.js). The domain-cooldown and concurrency-guard
// axes of that layer are keyed on the observation_sessions ledger, which
// this router's pipeline (trustprofile-scan-service.js -> saveScan()) never
// writes to, so they would be inert here and are deliberately not reused.
// Only the transport-level, pipeline-agnostic per-IP limiter applies
// cleanly; it is instantiated separately from public-scan's own limiter, so
// the two routes have independent budgets. Applied router-wide (router.use,
// before any route) so every sub-route — including the email-sending
// /submit-gate and the PDF-generating /download-pdf/:submissionId — is
// covered.
router.use(...createPublicScanRateLimit());

// ── POST /api/scan ────────────────────────────────────────────────────────────
//
// ADR-SYS-011 (Legacy Scanner Retirement): this route no longer calls the
// legacy-compat scoring engine. It now runs the SAME canonical Observatory
// pipeline as POST /api/public-scan and GET /api/organisation/:id, via
// trustprofile-scan-service.js — the one live scoring path for all new
// scans. Every persisted `scans` row this route creates is tagged
// scoring_version='trustprofile-v1'.

router.post('/', async (req, res, next) => {
  try {
    const raw = req.body.domain;
    if (!raw) throw new ValidationError('domain is required');

    const domain = String(raw).trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0];
    if (!validateDomain(domain)) throw new ValidationError(`Invalid domain: ${raw}`);

    const { score, riskLevel, scannedAt, totalPoints, maxPoints, scanners, scoreObject } =
      await executeTrustProfileScan(domain);

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
//
// ENG-011 §3 / ENG-012 §1.2 / §2 item 1 (T3.2, ENG-013 WP3) remediation: this
// endpoint previously accepted scanScore/scanResults/scoreObject directly
// from the client as OPTIONAL fields and persisted them verbatim as the
// submission's record of truth — the only server-side step was deriving a
// risk label FROM the already-client-supplied score. scanId is now
// mandatory, and every trust-bearing field is derived server-side from the
// referenced scan's persisted scanner_results (the evidence of record) — the
// client can no longer supply a score, results, or scoreObject at all. This
// route makes no write to the `scans` table itself — only a read of an
// existing, immutable row (append-only invariant, CLAUDE.md, untouched) plus
// an insert into `submissions` (unchanged shape).
function createSubmitGateHandler(deps = {}) {
  const {
    getScanByIdFn = getScanById,
    saveSubmissionFn = saveSubmission,
    sendConfirmationEmailFn = sendConfirmationEmail,
  } = deps;

  return async function postSubmitGate(req, res, next) {
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
        scanId,
      } = req.body;

      if (!domain)               throw new ValidationError('Domain is required');
      if (!email)                throw new ValidationError('Email is required');
      if (!EMAIL_RE.test(email)) throw new ValidationError('Invalid email format');
      if (!scanId)               throw new ValidationError('scanId is required');

      const trimmedDomain = String(domain).trim().toLowerCase();
      if (!validateDomain(trimmedDomain)) throw new ValidationError(`Invalid domain: ${trimmedDomain}`);

      const scan = await getScanByIdFn(scanId);
      if (!scan) return res.status(404).json({ success: false, error: 'Scan not found' });
      if (String(scan.domain).toLowerCase() !== trimmedDomain) {
        throw new ValidationError('scanId does not correspond to the supplied domain');
      }
      if (!Array.isArray(scan.scanner_results)) {
        throw new AppError('Scan record has no scanner results to derive from', 500);
      }

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

      // ── Derive server-side from the persisted evidence of record — never
      //    from client-supplied scanScore/scanResults/scoreObject. Dispatches
      //    on scan.scoring_version (ADR-SYS-011): legacy-tier rows go through
      //    the historical engine, trustprofile-v1 rows through the canonical
      //    Observatory-derived presentation — never assumed to be one or the
      //    other. ─────────────────────────────────────────────────────────
      const derived = derivation.deriveScanPresentationForRow(scan);

      const scannerMap = {};
      derived.scanners.forEach(s => { scannerMap[s.name] = s.score ?? null; });

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

      const dbResult = await saveSubmissionFn(
        submission.email,
        submission.domain,
        derived.score,
        derived.riskLevel,
        scanDetails,
        gateFormData,
        derived.scanners,
        derived.scoreObject,
        scanId,
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
      void sendConfirmationEmailFn(submission.email, submission.domain, derived.score, pdfLink)
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
  };
}

router.post('/submit-gate', createSubmitGateHandler());

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
module.exports.createSubmitGateHandler = createSubmitGateHandler;
