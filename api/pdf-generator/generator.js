'use strict';

const puppeteer = require('puppeteer');
const logger    = require('../../infra/utils/logger');
const derivation = require('../services/scan-derivation-service');

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  navy:    '#0B2545',
  success: '#16A34A',
  warning: '#F59E0B',
  critical:'#DC2626',
  high:    '#EA580C',
  bg:      '#F8FAFC',
  surface: '#FFFFFF',
  text:    '#111827',
  muted:   '#6B7280',
  border:  '#E5E7EB',
  light:   '#F3F4F6',
};

// ── Security Rating ───────────────────────────────────────────────────────────
// Rating value and risk-band label are both derived via the canonical
// derivation service (ADR-SYS-008 Phase A) — no threshold ladder is
// re-implemented here. Colour/background tokens are a presentation-only
// concern local to this generator, keyed off the label the service returns.
const calcRating = derivation.deriveRating999;

const RATING_BAND_COLORS = {
  'Excellent':     { color: '#15803D', bg: '#DCFCE7' },
  'Good':          { color: '#16A34A', bg: '#D1FAE5' },
  'Moderate Risk': { color: '#D97706', bg: '#FEF9C3' },
  'High Risk':     { color: '#EA580C', bg: '#FFEDD5' },
  'Critical Risk': { color: '#DC2626', bg: '#FEE2E2' },
};

function ratingBand(r) {
  const label = derivation.deriveRating999Label(r);
  return { label, ...RATING_BAND_COLORS[label] };
}

// ── Business language ─────────────────────────────────────────────────────────
const BUSINESS_RISK = {
  ssl: {
    fail: 'Encryption certificate issues — client communications may not be protected',
    warn: 'Encryption certificate requires attention before it causes disruption',
  },
  dns: {
    fail: 'Attackers may be able to impersonate your firm\'s email domain',
    warn: 'Email domain impersonation protection is incomplete',
  },
  headers: {
    fail: 'Website browser protections are not configured',
    warn: 'Website browser protections are incomplete',
  },
  tech: {
    fail: 'Outdated software with known vulnerabilities has been detected',
    warn: 'Technology information about your website is publicly exposed',
  },
  gdpr: {
    fail: 'Data protection compliance requirements are not met',
    warn: 'Data protection compliance has gaps that require attention',
  },
};

const PRIORITY_ACTION = {
  ssl: {
    name: 'Website Encryption Certificate', icon: '🔒',
    fail: {
      impact:      'Client data submitted through your website may not be encrypted. Visitors may see a security warning in their browser, damaging trust immediately.',
      action:      'Contact your web host or IT provider to renew or reinstall the SSL certificate. No changes to your website content or design are required.',
      time:        '1–2 hours',
      responsible: 'Web Host or IT Provider',
    },
    warn: {
      impact:      'Your encryption certificate is approaching expiry or has a configuration issue that should be resolved before it causes visitor-facing disruption.',
      action:      'Ask your web host to check the certificate expiry date and enable automatic renewal.',
      time:        '30 minutes',
      responsible: 'Web Host or IT Provider',
    },
  },
  dns: {
    name: 'Email Domain Protection', icon: '✉',
    fail: {
      impact:      'There are no controls preventing attackers from sending emails that appear to come from your firm. This creates a direct fraud risk to your clients and practice.',
      action:      'Instruct your IT provider or domain manager to implement email authentication controls. This is a DNS configuration change requiring no website downtime.',
      time:        '30–45 minutes',
      responsible: 'IT Provider or Domain Registrar',
    },
    warn: {
      impact:      'Email domain protection is only partially configured, leaving a gap that could be exploited for impersonation or phishing attacks.',
      action:      'Ask your IT provider to review and complete the email authentication configuration for your domain.',
      time:        '15–30 minutes',
      responsible: 'IT Provider or Domain Registrar',
    },
  },
  headers: {
    name: 'Website Security Configuration', icon: '&#128737;',
    fail: {
      impact:      'Your website is missing server-side protections that prevent attackers from injecting malicious content into pages visited by your clients.',
      action:      'Ask your web developer or host to configure security settings on your web server. No changes to website content or design are required.',
      time:        '30–60 minutes',
      responsible: 'Web Developer or Web Host',
    },
    warn: {
      impact:      'Some website browser protections are absent. Specific attack types remain possible depending on which protections are missing.',
      action:      'Share this report with your web developer and ask them to configure the missing security protections.',
      time:        '30 minutes',
      responsible: 'Web Developer or Web Host',
    },
  },
  tech: {
    name: 'Software Version Exposure', icon: '&#9881;',
    fail: {
      impact:      'Your website is advertising software with known security weaknesses. Automated attack tools actively scan for these disclosures and attempt to exploit them.',
      action:      'Ask your web developer to update all website software to current versions and suppress technical version information from public responses.',
      time:        '1–3 hours',
      responsible: 'Web Developer or Managed Hosting Provider',
    },
    warn: {
      impact:      'Technical information about your website infrastructure is publicly visible and could assist attackers in identifying potential weaknesses.',
      action:      'Ask your web host or developer to suppress server and software version information from public HTTP responses.',
      time:        '30–60 minutes',
      responsible: 'Web Developer or Web Host',
    },
  },
  gdpr: {
    name: 'Data Protection & Compliance', icon: '&#128203;',
    fail: {
      impact:      'Your website may not meet UK GDPR requirements. This creates potential regulatory risk and could result in ICO scrutiny or enforcement action.',
      action:      'Review your privacy policy, cookie consent mechanism and data handling practices with a compliance adviser or data protection officer.',
      time:        '2–4 hours',
      responsible: 'Compliance Manager or Data Protection Adviser',
    },
    warn: {
      impact:      'Some data protection requirements on your website are incomplete. These gaps create compliance risk under UK and EU data protection law.',
      action:      'Ask your web developer to review and update your cookie consent and privacy notice implementation.',
      time:        '1–2 hours',
      responsible: 'Web Developer and Compliance Manager',
    },
  },
};

// Technical names and check descriptions for the technical section
const TECH_META = {
  ssl:     { name: 'SSL/TLS Encryption',      desc: 'Certificate validity, expiry, TLS version and cipher strength.' },
  dns:     { name: 'Email Security (DNS)',     desc: 'SPF, DKIM and DMARC records for email authentication.' },
  headers: { name: 'HTTP Security Headers',   desc: 'CSP, HSTS, X-Frame-Options, X-Content-Type-Options and related headers.' },
  tech:    { name: 'Technology Detection',    desc: 'CMS, framework, server software versions and known vulnerability disclosures.' },
  gdpr:    { name: 'GDPR / Cookie Compliance',desc: 'Privacy policy, cookie consent, tracking scripts and data subject rights.' },
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function sanitize(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function generateReportId() {
  return 'SR-' + Date.now().toString(36).toUpperCase();
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); }
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function getTopRisks(results) {
  const order = ['dns', 'ssl', 'headers', 'tech', 'gdpr'];
  const risks = [];
  for (const key of order) {
    const r = results[key];
    if (!r || (r.status !== 'fail' && r.status !== 'warn')) continue;
    const text = BUSINESS_RISK[key]?.[r.status];
    if (text) risks.push({ text, severity: r.status });
  }
  risks.sort((a, b) => (a.severity === 'fail' ? -1 : 1) - (b.severity === 'fail' ? -1 : 1));
  return risks.slice(0, 3);
}

function getBusinessImpacts(results) {
  const out = [];
  if (results.dns?.status === 'fail')
    out.push('Direct client fraud risk from email impersonation targeting your firm');
  else if (results.dns?.status === 'warn')
    out.push('Elevated phishing risk due to incomplete email domain protection');
  if (results.ssl?.status === 'fail')
    out.push('Client data submitted through your website may not be encrypted');
  if (results.headers?.status === 'fail' || results.headers?.status === 'warn')
    out.push('Website visitors may be exposed to malicious content injection');
  if (results.gdpr?.status === 'fail' || results.gdpr?.status === 'warn')
    out.push('Regulatory scrutiny risk from data protection compliance gaps');
  if (results.tech?.status === 'fail')
    out.push('Website targeted by automated tools exploiting known vulnerabilities');
  out.push('Reputational damage and client trust loss if a security incident occurs');
  out.push('Unplanned recovery costs if issues are not addressed proactively');
  return out.slice(0, 5);
}

function getRemediationSummary(results) {
  const issues = Object.entries(results || {}).filter(([, r]) => r.status === 'fail' || r.status === 'warn');
  if (!issues.length) return { effort: 'No action required', cost: 'None', responsible: 'N/A', priority: 'No immediate action required' };

  const hasCritical = issues.some(([, r]) => r.status === 'fail');
  const timeMins    = { ssl: 90, dns: 45, headers: 45, tech: 120, gdpr: 150 };
  const total       = issues.reduce((s, [k]) => s + (timeMins[k] || 60), 0);
  const hrs         = Math.ceil(total / 60);
  const effort      = hrs <= 1 ? 'Under 1 hour' : `${hrs}–${hrs + 2} hours`;
  const keys        = issues.map(([k]) => k);
  const hasGdpr     = keys.includes('gdpr');
  const responsible = hasGdpr && keys.length > 1
    ? 'Web Developer, IT Provider and Compliance Manager'
    : hasGdpr ? 'Compliance Manager or Data Protection Adviser'
    : 'Web Developer or IT Provider';

  return {
    effort,
    cost:      'Low — configuration changes, no new software required',
    responsible,
    priority:  hasCritical ? 'Immediate action recommended within 7 days' : 'Action recommended within 30 days',
  };
}

// ── HTML component helpers ────────────────────────────────────────────────────
function sectionHeading(title) {
  return `<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${C.navy};padding-bottom:8px;border-bottom:2px solid ${C.navy};margin-bottom:12px;">${title}</div>`;
}

function pageHeader(title, domain) {
  return `
    <div style="background:${C.navy};padding:11px 36px;display:flex;justify-content:space-between;align-items:center;">
      <div style="color:#fff;font-size:14px;font-weight:800;letter-spacing:0.08em;">SOTERIUS</div>
      <div style="color:rgba(255,255,255,0.9);font-size:11px;font-weight:600;">${title}</div>
      <div style="color:rgba(255,255,255,0.55);font-size:10px;">${sanitize(domain)}</div>
    </div>`;
}

function ratingScaleBar(rating) {
  const pct        = Math.min(98, Math.max(2, (rating / 999) * 100));
  const segments   = [
    { flex: 300, color: '#DC2626' },
    { flex: 200, color: '#EA580C' },
    { flex: 150, color: '#F59E0B' },
    { flex: 150, color: '#84CC16' },
    { flex: 199, color: '#16A34A' },
  ];
  return `
    <div style="position:relative;margin:18px 0 6px;">
      <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;">
        ${segments.map(s => `<div style="flex:${s.flex};background:${s.color};"></div>`).join('')}
      </div>
      <div style="position:absolute;top:-4px;left:${pct}%;transform:translateX(-50%);width:16px;height:16px;background:#fff;border:3px solid ${C.navy};border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.2);"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:9px;color:${C.muted};margin-top:14px;">
      <span>Critical</span><span>High</span><span>Moderate</span><span>Good</span><span>Excellent</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:8px;color:#9CA3AF;margin-top:1px;">
      <span>0</span><span>400</span><span>599</span><span>749</span><span>999</span>
    </div>`;
}

function scorecard(results) {
  const vals     = Object.values(results || {});
  const critical = vals.filter(r => r.status === 'fail').length;
  const warnings = vals.filter(r => r.status === 'warn').length;
  const passed   = vals.filter(r => r.status === 'pass').length;
  const total    = vals.filter(r => ['fail','warn','pass'].includes(r.status)).length;

  const card = (n, label, color, bg) => `
    <div style="flex:1;background:${bg};border-radius:8px;padding:12px 8px;text-align:center;border:1px solid ${color}30;">
      <div style="font-size:26px;font-weight:800;color:${color};line-height:1;">${n}</div>
      <div style="font-size:9px;font-weight:700;color:${color};margin-top:4px;text-transform:uppercase;letter-spacing:0.05em;">${label}</div>
    </div>`;

  return `
    <div style="display:flex;gap:8px;">
      ${card(critical, 'Critical',        C.critical, '#FEF2F2')}
      ${card(warnings, 'Warnings',        C.warning,  '#FFFBEB')}
      ${card(passed,   'Passed',          C.success,  '#F0FDF4')}
      ${card(total,    'Areas Checked',   C.navy,     '#EFF6FF')}
    </div>`;
}

// ── Category breakdown helper ─────────────────────────────────────────────────
const CAT_DISPLAY = {
  ssl:      'SSL/TLS Encryption',
  email:    'Email Security',
  headers:  'Security Headers',
  vulnComp: 'Vulnerable Components',
  gdpr:     'GDPR / Cookie Compliance',
};

function bandColor(rating) {
  if (rating === 'Excellent')     return '#15803D';
  if (rating === 'Good')          return '#16A34A';
  if (rating === 'Moderate Risk') return '#D97706';
  if (rating === 'High Risk')     return '#EA580C';
  return '#DC2626';
}

function categoryBreakdownHtml(breakdown) {
  if (!breakdown) return '';
  const rows = ['ssl', 'email', 'headers', 'vulnComp', 'gdpr']
    .filter(k => breakdown[k])
    .map(k => {
      const cat   = breakdown[k];
      const name  = CAT_DISPLAY[k] || k;
      const pct   = cat.percentage ?? 0;
      const rat   = cat.rating     || 'Critical Risk';
      const color = bandColor(rat);
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid ${C.light};">
          <div style="font-size:10px;color:${C.text};flex:1;">${sanitize(name)}</div>
          <div style="font-size:10px;font-weight:700;color:${color};min-width:28px;text-align:right;">${pct}%</div>
          <div style="background:${color}20;color:${color};font-size:9px;font-weight:700;padding:2px 8px;border-radius:99px;white-space:nowrap;">${sanitize(rat)}</div>
        </div>`;
    }).join('');
  return rows ? `<div style="margin-top:10px;">${rows}</div>` : '';
}

// ── Page 1: Executive Dashboard ───────────────────────────────────────────────
function buildPage1(scanData, results, rating, band, reportId, scoreObject) {
  const topRisks    = getTopRisks(results);
  const impacts     = getBusinessImpacts(results);
  const remediation = getRemediationSummary(results);

  const riskRows = topRisks.length
    ? topRisks.map(r => `
        <div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid ${C.light};">
          <span style="font-size:13px;line-height:1.5;flex-shrink:0;">${r.severity === 'fail' ? '&#128308;' : '&#128992;'}</span>
          <span style="font-size:11px;color:${C.text};line-height:1.55;">${sanitize(r.text)}</span>
        </div>`).join('')
    : `<p style="font-size:11px;color:${C.success};font-style:italic;padding:8px 0;">&#10003; No significant risks identified — all checks passed.</p>`;

  const impactItems = impacts.map(i => `
    <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px;">
      <span style="color:${C.navy};font-weight:700;flex-shrink:0;font-size:12px;">•</span>
      <span style="font-size:11px;color:#374151;line-height:1.55;">${sanitize(i)}</span>
    </div>`).join('');

  const remRows = [
    ['Estimated Effort', remediation.effort],
    ['Estimated Cost',   remediation.cost],
    ['Responsible',      remediation.responsible],
    ['Priority',         remediation.priority],
  ].map(([label, val]) => `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid ${C.light};">
      <span style="font-size:10px;color:${C.muted};font-weight:600;white-space:nowrap;">${sanitize(label)}</span>
      <span style="font-size:11px;color:${C.text};font-weight:600;text-align:right;flex:1;">${sanitize(val)}</span>
    </div>`).join('');

  return `
    <!-- ══ HEADER ══ -->
    <div style="background:${C.navy};padding:14px 36px;display:flex;justify-content:space-between;align-items:center;">
      <div style="color:#fff;font-size:16px;font-weight:800;letter-spacing:0.08em;">SOTERIUS</div>
      <div style="text-align:right;">
        <div style="color:rgba(255,255,255,0.95);font-size:11px;font-weight:600;">Website Security Rating Report</div>
        <div style="color:rgba(255,255,255,0.45);font-size:9px;letter-spacing:0.06em;margin-top:2px;">CONFIDENTIAL</div>
      </div>
    </div>

    <!-- ══ META ROW ══ -->
    <div style="background:#fff;border-bottom:1px solid ${C.border};padding:10px 36px;display:flex;">
      <div style="flex:1;padding-right:20px;border-right:1px solid ${C.border};">
        <div style="font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:0.07em;margin-bottom:2px;">Domain</div>
        <div style="font-size:13px;font-weight:700;color:${C.text};">${sanitize(scanData.domain)}</div>
      </div>
      <div style="flex:1;padding:0 20px;border-right:1px solid ${C.border};">
        <div style="font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:0.07em;margin-bottom:2px;">Scan Date</div>
        <div style="font-size:13px;font-weight:700;color:${C.text};">${formatDate(scanData.timestamp)}</div>
      </div>
      <div style="flex:1;padding-left:20px;">
        <div style="font-size:9px;color:${C.muted};text-transform:uppercase;letter-spacing:0.07em;margin-bottom:2px;">Report ID</div>
        <div style="font-size:13px;font-weight:700;color:${C.text};">${sanitize(reportId)}</div>
      </div>
    </div>

    <!-- ══ TWO-COLUMN BODY ══ -->
    <div style="padding:20px 36px;display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">

      <!-- LEFT -->
      <div>
        <!-- Rating card -->
        <div style="background:#fff;border:1px solid ${C.border};border-radius:10px;padding:22px 20px;margin-bottom:14px;text-align:center;">
          <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:${C.muted};margin-bottom:10px;">SECURITY RATING</div>
          <div style="font-size:62px;font-weight:900;color:${C.navy};line-height:1;letter-spacing:-2px;">${rating}</div>
          <div style="font-size:11px;color:#9CA3AF;margin-bottom:12px;">out of 999</div>
          <div style="display:inline-block;background:${band.bg};color:${band.color};font-size:12px;font-weight:700;padding:5px 20px;border-radius:99px;text-transform:uppercase;letter-spacing:0.06em;border:1.5px solid ${band.color}50;">
            ${sanitize(band.label)}
          </div>
          ${ratingScaleBar(rating)}
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid ${C.light};">
            <div style="display:flex;justify-content:space-between;font-size:9px;color:${C.muted};">
              <span>899–999 Excellent</span><span>749–898 Good</span><span>599–748 Moderate</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:9px;color:${C.muted};margin-top:2px;">
              <span>400–598 High Risk</span><span>0–399 Critical Risk</span>
            </div>
          </div>
        </div>

        <!-- Scorecard -->
        <div style="background:#fff;border:1px solid ${C.border};border-radius:10px;padding:16px 18px;margin-bottom:14px;">
          ${sectionHeading('SECURITY OVERVIEW')}
          ${scorecard(results)}
          ${categoryBreakdownHtml(scoreObject?.categoryBreakdown)}
        </div>

        <!-- Remediation summary -->
        <div style="background:#fff;border:1px solid ${C.border};border-radius:10px;padding:16px 18px;">
          ${sectionHeading('REMEDIATION SUMMARY')}
          ${remRows}
        </div>
      </div>

      <!-- RIGHT -->
      <div>
        <!-- Top risks -->
        <div style="background:#fff;border:1px solid ${C.border};border-radius:10px;padding:16px 18px;margin-bottom:14px;">
          ${sectionHeading('TOP RISKS IDENTIFIED')}
          ${riskRows}
        </div>

        <!-- Business impact -->
        <div style="background:#fff;border:1px solid ${C.border};border-radius:10px;padding:16px 18px;">
          ${sectionHeading('WHAT THIS MEANS FOR YOUR FIRM')}
          <p style="font-size:11px;color:${C.muted};margin-bottom:10px;line-height:1.5;">If the identified issues are not addressed, potential consequences include:</p>
          ${impactItems}
          <div style="margin-top:14px;padding:10px 12px;background:#EFF6FF;border-left:3px solid ${C.navy};border-radius:0 4px 4px 0;">
            <div style="font-size:10px;font-weight:700;color:${C.navy};margin-bottom:3px;">RECOMMENDED NEXT STEP</div>
            <p style="font-size:11px;color:#1E3A5F;line-height:1.55;">Share this report with your IT provider or web developer. Priority actions with specific instructions are detailed overleaf.</p>
          </div>
        </div>
      </div>

    </div>`;
}

// ── Page 2: Priority Actions ──────────────────────────────────────────────────
function buildPage2(results, domain, reportId) {
  const order = ['dns', 'ssl', 'headers', 'tech', 'gdpr'];
  const items = [];
  for (const key of order) {
    const r = results[key];
    if (!r || (r.status !== 'fail' && r.status !== 'warn')) continue;
    const meta   = PRIORITY_ACTION[key];
    const detail = meta?.[r.status];
    if (!meta || !detail) continue;
    items.push({ ...detail, name: meta.name, icon: meta.icon, severity: r.status });
  }

  const sevBadge = sev => {
    const isCrit = sev === 'fail';
    return `<span style="display:inline-block;background:${isCrit ? '#FEE2E2' : '#FEF9C3'};color:${isCrit ? C.critical : '#D97706'};font-size:9px;font-weight:700;padding:3px 10px;border-radius:99px;text-transform:uppercase;letter-spacing:0.05em;">${isCrit ? 'Critical' : 'Advisory'}</span>`;
  };

  const noIssuesHtml = `
    <div style="text-align:center;padding:48px 24px;">
      <div style="font-size:32px;margin-bottom:12px;">&#9989;</div>
      <div style="font-size:16px;font-weight:700;color:${C.success};margin-bottom:8px;">All Checks Passed</div>
      <p style="font-size:12px;color:${C.muted};">No priority actions are required at this time.</p>
    </div>`;

  const actionCards = items.map(item => `
    <div style="background:#fff;border:1px solid ${C.border};border-radius:8px;overflow:hidden;margin-bottom:14px;page-break-inside:avoid;">
      <div style="background:${item.severity === 'fail' ? '#FEF2F2' : '#FFFBEB'};padding:10px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid ${item.severity === 'fail' ? '#FECACA' : '#FDE68A'};">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:15px;">${item.icon}</span>
          <span style="font-size:13px;font-weight:700;color:${C.text};">${sanitize(item.name)}</span>
        </div>
        ${sevBadge(item.severity)}
      </div>
      <div style="padding:12px 16px;display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div>
          <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:${C.muted};margin-bottom:5px;">Business Impact</div>
          <p style="font-size:11px;color:#374151;line-height:1.6;">${sanitize(item.impact)}</p>
        </div>
        <div>
          <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:${C.muted};margin-bottom:5px;">Recommended Action</div>
          <p style="font-size:11px;color:#374151;line-height:1.6;">${sanitize(item.action)}</p>
        </div>
      </div>
      <div style="background:${C.bg};padding:8px 16px;display:flex;gap:28px;border-top:1px solid ${C.light};">
        <div><span style="font-size:9px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:0.04em;">Est. Time: </span><span style="font-size:11px;font-weight:700;color:${C.text};">${sanitize(item.time)}</span></div>
        <div><span style="font-size:9px;font-weight:600;color:${C.muted};text-transform:uppercase;letter-spacing:0.04em;">Responsible: </span><span style="font-size:11px;font-weight:700;color:${C.text};">${sanitize(item.responsible)}</span></div>
      </div>
    </div>`).join('');

  return `
    <div class="page-break">
      ${pageHeader('TOP PRIORITY ACTIONS', domain)}
      <div style="padding:20px 36px;">
        <p style="font-size:11px;color:${C.muted};margin-bottom:18px;line-height:1.6;">Actions are presented in priority order. Critical issues should be addressed within 7 days. Advisory issues should be planned within 30 days. This section can be shared directly with your IT provider or web developer.</p>
        ${items.length ? actionCards : noIssuesHtml}
      </div>
    </div>`;
}

// ── Technical Details section ─────────────────────────────────────────────────
function buildTechnicalSection(results, domain) {
  const statusStyle = {
    pass:  { bg: '#F0FDF4', color: '#15803D', label: 'PASS',    icon: '&#10003;' },
    warn:  { bg: '#FFFBEB', color: '#D97706', label: 'WARNING', icon: '&#9888;'  },
    fail:  { bg: '#FEF2F2', color: '#DC2626', label: 'FAIL',    icon: '&#10007;' },
    error: { bg: '#F8FAFC', color: '#6B7280', label: 'ERROR',   icon: '?'         },
  };

  const order = ['ssl', 'dns', 'headers', 'tech', 'gdpr'];
  const cards = order.map(key => {
    const r    = results[key];
    if (!r) return '';
    const meta = TECH_META[key] || { name: key, desc: '' };
    const ss   = statusStyle[r.status] || statusStyle.error;
    const issuesHtml = r.issues?.length
      ? `<ul style="margin:8px 0 0 0;padding-left:16px;">${r.issues.map(i => `<li style="font-size:10px;color:#374151;margin-bottom:4px;line-height:1.5;">${sanitize(i)}</li>`).join('')}</ul>`
      : `<p style="font-size:10px;color:${C.success};margin-top:8px;font-style:italic;">&#10003; No issues detected for this check.</p>`;

    return `
      <div style="background:#fff;border:1px solid ${C.border};border-radius:8px;overflow:hidden;margin-bottom:12px;page-break-inside:avoid;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:${C.bg};border-bottom:1px solid ${C.border};">
          <div>
            <div style="font-size:12px;font-weight:700;color:${C.text};">${sanitize(meta.name)}</div>
            <div style="font-size:9px;color:${C.muted};margin-top:2px;">${sanitize(meta.desc)}</div>
          </div>
          <span style="display:inline-block;background:${ss.bg};color:${ss.color};font-size:9px;font-weight:700;padding:3px 10px;border-radius:99px;letter-spacing:0.05em;text-transform:uppercase;">${ss.icon} ${ss.label}</span>
        </div>
        <div style="padding:10px 14px;">${issuesHtml}</div>
      </div>`;
  }).join('');

  return `
    <div class="page-break">
      ${pageHeader('TECHNICAL FINDINGS', domain)}
      <div style="padding:20px 36px;">
        <p style="font-size:11px;color:${C.muted};margin-bottom:16px;line-height:1.6;">This section provides technical details for IT providers, web developers and compliance managers. Each check is listed below with the specific issues identified.</p>
        ${cards}
      </div>
    </div>`;
}

// ── Monitoring section ────────────────────────────────────────────────────────
function buildMonitoringSection(domain) {
  return `
    <div style="padding:28px 36px;page-break-inside:avoid;">
      <div style="background:#fff;border:1px solid ${C.border};border-radius:10px;padding:24px 28px;">
        ${sectionHeading('WHY CONTINUOUS MONITORING MATTERS')}
        <p style="font-size:12px;color:#374151;line-height:1.7;margin-bottom:14px;">This report reflects the security posture of <strong>${sanitize(domain)}</strong> at a single point in time. Websites, DNS records, SSL certificates and server configurations can change without warning — through software updates, hosting changes, third-party integrations or routine maintenance.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px;">
          ${[
            ['SSL Certificate Expiry',     'Certificates expire automatically. A missed renewal causes immediate visitor-facing disruption.'],
            ['DNS Configuration Changes',  'Email authentication records can be overwritten during domain or hosting migrations.'],
            ['Software Updates',           'New vulnerabilities are discovered in website software continuously. Unpatched versions become targets.'],
          ].map(([title, body]) => `
            <div style="background:${C.bg};border-radius:8px;padding:14px;border:1px solid ${C.border};">
              <div style="font-size:11px;font-weight:700;color:${C.navy};margin-bottom:6px;">${sanitize(title)}</div>
              <p style="font-size:10px;color:#374151;line-height:1.6;">${sanitize(body)}</p>
            </div>`).join('')}
        </div>
        <div style="background:#EFF6FF;border-left:3px solid ${C.navy};padding:12px 16px;border-radius:0 6px 6px 0;">
          <div style="font-size:10px;font-weight:700;color:${C.navy};margin-bottom:4px;">RECOMMENDED</div>
          <p style="font-size:11px;color:#1E3A5F;line-height:1.6;">Schedule a follow-up Soterius scan in 30 days to verify that issues have been resolved and your Security Rating has improved. Regular rescanning helps identify new risks before they become incidents.</p>
        </div>
      </div>

      <!-- Disclaimer -->
      <div style="margin-top:20px;padding-top:14px;border-top:1px solid ${C.border};">
        <p style="font-size:9px;color:#9CA3AF;line-height:1.7;">This report was generated by Soterius and reflects automated checks performed at the time of the scan. It is not a penetration test, security audit or professional compliance assessment. Findings should be reviewed with a qualified IT or compliance professional before remediation decisions are made. Soterius does not guarantee that all vulnerabilities will be identified. Typical consequences described are illustrative and based on publicly reported incidents; actual outcomes may vary. This document is intended for the named domain only and should be treated as confidential.</p>
      </div>
    </div>`;
}

// ── Full HTML assembler ───────────────────────────────────────────────────────
function buildFullHTML(scanData) {
  const results     = scanData.results || {};
  const score       = scanData.overallScore ?? 0;
  const rating      = calcRating(score);
  const band        = ratingBand(rating);
  const reportId    = generateReportId();
  const scoreObject = scanData.scoreObject ?? null;

  const globalCss = `
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:Arial,Helvetica,sans-serif; background:${C.bg}; color:${C.text}; font-size:12px; line-height:1.5; -webkit-font-smoothing:antialiased; }
    .page-break { page-break-before:always; break-before:page; }
    .no-break { page-break-inside:avoid; break-inside:avoid; }
  `;

  const page1 = buildPage1(scanData, results, rating, band, reportId, scoreObject);
  const page2 = buildPage2(results, scanData.domain, reportId);
  const tech  = buildTechnicalSection(results, scanData.domain);
  const mon   = buildMonitoringSection(scanData.domain);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Soterius Security Rating Report — ${sanitize(scanData.domain)}</title>
  <style>${globalCss}</style>
</head>
<body>
  ${page1}
  ${page2}
  ${tech}
  ${mon}
</body>
</html>`;
}

// ── PDF generation ────────────────────────────────────────────────────────────
async function generatePDF(scanData) {
  const html    = buildFullHTML(scanData);
  const browser = await puppeteer.launch({
    headless:        true,
    executablePath:  process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args:            ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const raw = await page.pdf({
      format:               'A4',
      printBackground:      true,
      displayHeaderFooter:  false,
      margin:               { top: '0', bottom: '0', left: '0', right: '0' },
    });
    const pdf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    logger.info(`PDF generated for ${scanData.domain} — rating ${calcRating(scanData.overallScore ?? 0)} (${pdf.length} bytes)`);
    return pdf;
  } finally {
    await browser.close();
  }
}

module.exports = { generatePDF };
