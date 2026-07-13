'use strict';

// trust-profile-pdf.js — Compliance Advisor MVP (ENG-047/ENG-048).
//
// Renders an already-generated Trust Profile Instance (ENG-023's 9 fields,
// unmodified) into a branded PDF. This module never computes, re-derives, or
// re-interprets a score — every value it prints (trustScore.value/band,
// componentBreakdown, categoryScores) is read verbatim from the instance
// handed to it. No import of anything under backend/trust-intelligence/ or
// backend/api/legacy-compat/ — this is a presentation-only consumer of an
// already-frozen, already-tested data shape, exactly as ENG-047 §2 requires.
//
// Puppeteer usage (launch args, page.pdf() options, Buffer.isBuffer guard
// for Puppeteer v22+'s Uint8Array return) mirrors the existing
// api/pdf-generator/generator.js — a proven pattern, reused here as a
// convention, not imported directly, since that module's own data shape
// (legacy 5-scanner results) has nothing in common with a Trust Profile
// Instance and importing it would pull in legacy scoring machinery
// (scan-derivation-service's deriveRating999) this module has no business
// touching.

const puppeteer = require('puppeteer');
const logger = require('../../infra/utils/logger');

const C = {
  navy: '#0B2545',
  success: '#16A34A',
  warning: '#F59E0B',
  critical: '#DC2626',
  bg: '#F8FAFC',
  border: '#E5E7EB',
  text: '#111827',
  muted: '#6B7280',
};

const CATEGORY_NAMES = {
  A: 'Email Trust',
  B: 'Domain Trust',
  C: 'Disclosure',
  D: 'Certificate & TLS Trust',
};

function sanitize(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
}

function bandColor(band) {
  if (band === 'Excellent' || band === 'Good') return C.success;
  if (band === 'Moderate') return C.warning;
  return C.critical;
}

function componentRowHtml(item) {
  const color = item.observed ? (item.earned >= item.weight * 0.7 ? C.success : item.earned > 0 ? C.warning : C.critical) : C.muted;
  const label = item.observed ? `${item.earned}/${item.weight}` : 'Not observed';
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid ${C.border};">
      <div style="font-size:11px;color:${C.text};flex:1;text-transform:uppercase;letter-spacing:0.03em;">${sanitize(item.id)}</div>
      <div style="font-size:9px;color:${C.muted};min-width:120px;">${sanitize(CATEGORY_NAMES[item.category] || item.category)}</div>
      <div style="font-size:11px;font-weight:700;color:${color};min-width:80px;text-align:right;">${sanitize(label)}</div>
    </div>`;
}

function buildHtml({ instance, organisationName, consultancyName }) {
  const { trustScore, componentBreakdown, organisationId, generatedAt } = instance;
  const isInsufficient = trustScore.value === 'INSUFFICIENT_OBSERVATION';
  const scoreDisplay = isInsufficient ? '—' : trustScore.value;
  const bandLabel = isInsufficient ? 'Insufficient Observation' : (trustScore.band || '—');
  const color = isInsufficient ? C.muted : bandColor(trustScore.band);

  const rows = (componentBreakdown || []).map(componentRowHtml).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Trust Profile Report — ${sanitize(organisationName)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; background: ${C.bg}; color: ${C.text}; font-size: 12px; line-height: 1.5; }
</style>
</head>
<body>
  <div style="background:${C.navy};padding:14px 36px;display:flex;justify-content:space-between;align-items:center;">
    <div style="color:#fff;font-size:14px;font-weight:800;letter-spacing:0.06em;">${sanitize(consultancyName || 'Compliance Advisor')}</div>
    <div style="color:rgba(255,255,255,0.7);font-size:10px;">Trust Profile Report</div>
  </div>

  <div style="padding:24px 36px;">
    <div style="background:#fff;border:1px solid ${C.border};border-radius:10px;padding:20px 24px;margin-bottom:18px;">
      <div style="font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px;">Organisation</div>
      <div style="font-size:16px;font-weight:700;">${sanitize(organisationName)}</div>
      <div style="font-size:10px;color:${C.muted};margin-top:2px;">${sanitize(organisationId)} &middot; generated ${sanitize(formatDate(generatedAt))}</div>
    </div>

    <div style="display:flex;gap:18px;margin-bottom:18px;">
      <div style="flex:1;background:#fff;border:1px solid ${C.border};border-radius:10px;padding:20px;text-align:center;">
        <div style="font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px;">Trust Score</div>
        <div style="font-size:44px;font-weight:900;color:${C.navy};line-height:1;">${sanitize(scoreDisplay)}</div>
        <div style="display:inline-block;margin-top:10px;background:${color}20;color:${color};font-size:11px;font-weight:700;padding:4px 14px;border-radius:99px;">${sanitize(bandLabel)}</div>
      </div>
      <div style="flex:2;background:#fff;border:1px solid ${C.border};border-radius:10px;padding:20px;">
        <div style="font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:0.07em;margin-bottom:10px;">Signal Breakdown</div>
        ${rows || '<p style="font-size:11px;color:' + C.muted + ';font-style:italic;">No signals observed for this domain yet.</p>'}
      </div>
    </div>

    <div style="margin-top:24px;padding-top:14px;border-top:1px solid ${C.border};">
      <p style="font-size:9px;color:#9CA3AF;line-height:1.7;">This report reflects a Trust Profile Instance generated by Soterius's Trust Intelligence platform at the timestamp shown above. It is a point-in-time record and is not re-derived or recalculated by this report. Prepared for ${sanitize(consultancyName || 'the requesting advisor')}.</p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * generateTrustProfilePdf({ instance, organisationName, consultancyName }) → Promise<Buffer>
 * instance: a Trust Profile Instance (ENG-023's 9 fields) — read verbatim, never recomputed.
 */
async function generateTrustProfilePdf({ instance, organisationName, consultancyName }) {
  const html = buildHtml({ instance, organisationName, consultancyName });
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const raw = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
    const pdf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    logger.info(`Trust Profile PDF generated for ${instance.organisationId} (${pdf.length} bytes)`);
    return pdf;
  } finally {
    await browser.close();
  }
}

module.exports = { generateTrustProfilePdf, buildHtml };
