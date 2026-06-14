'use strict';
/**
 * Analyse Benchmark Cohort 001 — check-level findings aggregation.
 * Fetches the most recent scan per prospect, aggregates every check result,
 * and writes BENCHMARK_FINDINGS_001.md to the project root.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path = require('path');
const fs   = require('fs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REPORT_PATH = path.join(__dirname, '../../BENCHMARK_FINDINGS_001.md');
const TODAY       = new Date().toISOString().slice(0, 10);

// Points available per check by scanner category (for points-lost calculation).
// Headers uses explicit `points` on each check — handled separately.
const SCANNER_PTS = {
  'SSL/TLS Encryption':      { PASS: 10, WARNING: 5, FAIL: 0 },
  'Email Security':          { PASS:  8, WARNING: 4, FAIL: 0 },
  'Vulnerable Components':   { PASS:  4, WARNING: 2, FAIL: 0 },
  'GDPR / Cookie Compliance':{ PASS:  2, WARNING: 1, FAIL: 0 },
};

// Risk category label for each scanner.
const SCANNER_RISK_CATEGORY = {
  'SSL/TLS Encryption':       'Transport Security',
  'Email Security':           'Email Authentication',
  'Security Headers':         'Browser Security',
  'Vulnerable Components':    'Software Security',
  'GDPR / Cookie Compliance': 'Compliance',
};

// Severity: checks that are HIGH vs MEDIUM vs LOW.
const SEVERITY_MAP = {
  // Email
  'DMARC record':              'High',
  'DMARC policy':              'High',
  'SPF record':                'High',
  'DKIM record':               'Medium',
  // SSL
  'Valid SSL certificate':     'High',
  'HSTS':                      'High',
  // Headers
  'Content Security Policy':   'High',
  'X-Frame-Options':           'Medium',
  'X-Content-Type-Options':    'Medium',
  'Referrer-Policy':           'Medium',
  // VulnComp
  'Known CVEs':                'High',
  'Outdated libraries':        'High',
  'Technology fingerprinting': 'Low',
  // GDPR
  'Cookie consent':            'Medium',
};

function severity(checkName) {
  for (const [k, v] of Object.entries(SEVERITY_MAP)) {
    if (checkName.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return 'Medium';
}

function pad(s, n) { return String(s).padEnd(n); }

(async () => {
  // ── 1. Load all prospects ─────────────────────────────────────────────────
  const { data: prospects, error: pErr } = await supabase
    .from('prospects')
    .select('id, firm_name, website');
  if (pErr) { console.error('Failed to load prospects:', pErr.message); process.exit(1); }

  console.log(`Loaded ${prospects.length} prospects.`);

  // ── 2. Get the most recent scan per prospect ──────────────────────────────
  const scans = [];
  for (const p of prospects) {
    const { data, error } = await supabase
      .from('scans')
      .select('id, overall_score, risk_band, scanner_results, scanned_at, score_object')
      .eq('prospect_id', p.id)
      .order('scanned_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) { console.error(`  ✗ ${p.website}:`, error.message); continue; }
    if (!data)  { console.warn(`  — No scan: ${p.website}`); continue; }
    scans.push({ prospect: p, scan: data });
  }

  console.log(`Using ${scans.length} scans for analysis.`);
  const TOTAL = scans.length;

  // ── 3. Aggregate checks ───────────────────────────────────────────────────
  // Map: checkKey → { name, category, failCount, warnCount, passCount, examples, pointsLost }
  const checkMap = new Map();

  for (const { prospect, scan } of scans) {
    const scanners = scan.scanner_results || [];
    for (const scanner of scanners) {
      const cat  = SCANNER_RISK_CATEGORY[scanner.name] || scanner.name;
      const pts  = SCANNER_PTS[scanner.name] || null;

      for (const check of (scanner.checks || [])) {
        const key = `${scanner.name}::${check.name}`;
        if (!checkMap.has(key)) {
          checkMap.set(key, {
            name:       check.name,
            scanner:    scanner.name,
            category:   cat,
            failCount:  0,
            warnCount:  0,
            passCount:  0,
            examples:   [],
            pointsLost: 0,
          });
        }
        const entry  = checkMap.get(key);
        const status = String(check.status || '').toUpperCase();

        if (status === 'FAIL') {
          entry.failCount++;
          if (entry.examples.length < 3 && check.details) {
            entry.examples.push({ domain: prospect.website, detail: check.details });
          }
          // Points lost = what PASS would have scored minus what was actually earned.
          if (pts) {
            entry.pointsLost += pts.PASS;
          } else if (typeof check.points === 'number') {
            // Headers/DMARC — compare against what the check is worth at max.
            // Estimate max = 10 for headers checks (max 50 / 5 checks = 10 avg).
            // We track explicit points lost using the score_object where available.
            const maxForCheck = check.maxPoints ?? 10;
            entry.pointsLost += maxForCheck - check.points;
          }
        } else if (status === 'WARNING') {
          entry.warnCount++;
          if (entry.examples.length < 3 && check.details) {
            entry.examples.push({ domain: prospect.website, detail: `[WARNING] ${check.details}` });
          }
          if (pts) {
            entry.pointsLost += pts.PASS - pts.WARNING;
          } else if (typeof check.points === 'number') {
            const maxForCheck = check.maxPoints ?? 10;
            entry.pointsLost += maxForCheck - check.points;
          }
        } else {
          entry.passCount++;
        }
      }
    }
  }

  // ── 4. Sort and rank ──────────────────────────────────────────────────────
  const allChecks = [...checkMap.values()];

  // FAILs only ranked by failCount desc, then warnCount desc
  const failRanked = allChecks
    .filter(c => c.failCount > 0)
    .sort((a, b) => b.failCount - a.failCount || b.warnCount - a.warnCount);

  // Warnings ranked by warnCount desc
  const warnRanked = allChecks
    .filter(c => c.warnCount > 0 && c.failCount === 0)
    .sort((a, b) => b.warnCount - a.warnCount);

  // Combined fail+warn for top 10 (treating FAIL as 2×, WARNING as 1×)
  const combinedRanked = allChecks
    .filter(c => c.failCount + c.warnCount > 0)
    .sort((a, b) => (b.failCount * 2 + b.warnCount) - (a.failCount * 2 + a.warnCount));

  const top10 = combinedRanked.slice(0, 10);

  // Quick wins: FAILs with highest count but "easy to fix" category (headers, email monitoring)
  const quickWinCategories = ['Browser Security', 'Compliance'];
  const quickWins = [...allChecks]
    .filter(c => c.failCount + c.warnCount > 0)
    .sort((a, b) => {
      const aScore = (quickWinCategories.includes(a.category) ? 10 : 0) + a.failCount + a.warnCount;
      const bScore = (quickWinCategories.includes(b.category) ? 10 : 0) + b.failCount + b.warnCount;
      return bScore - aScore;
    })
    .slice(0, 5);

  // High impact: ranked by total points lost across cohort
  const highImpact = [...allChecks]
    .filter(c => c.pointsLost > 0)
    .sort((a, b) => b.pointsLost - a.pointsLost)
    .slice(0, 5);

  // Print summary to console
  console.log('\n── Top 10 Failed/Warning Checks ─────────────────────────────────────────');
  console.log(pad('Rank', 5) + pad('Check', 40) + pad('FAIL', 6) + pad('WARN', 6) + pad('% Affected', 12) + 'Category');
  top10.forEach((c, i) => {
    const pct = Math.round(((c.failCount + c.warnCount) / TOTAL) * 100);
    console.log(
      pad(`${i+1}.`, 5) +
      pad(c.name, 40) +
      pad(c.failCount, 6) +
      pad(c.warnCount, 6) +
      pad(`${pct}%`, 12) +
      c.category
    );
  });

  // ── 5. Write BENCHMARK_FINDINGS_001.md ────────────────────────────────────
  const pct  = n => `${Math.round((n / TOTAL) * 100)}%`;
  const both = c => c.failCount + c.warnCount;

  let md = `# Benchmark Findings 001 — North Wales Solicitors
## Soterius Check-Level Analysis

**Cohort:** Benchmark Cohort 001 — North Wales Solicitor Benchmark
**Firms Analysed:** ${TOTAL}
**Scan Date:** ${TODAY}
**Scoring Version:** Security Rating v1.0

This report analyses the individual check results stored for all ${TOTAL} firms in Benchmark Cohort 001.
Every check recorded across all five scanner categories is included. Rankings are by frequency of FAIL
or WARNING outcome across the cohort.

---

## Top 10 Failed and Warning Checks

`;

  top10.forEach((c, i) => {
    const affected = both(c);
    const affectedPct = pct(affected);
    const sev = severity(c.name);
    const example = c.examples[0];

    md += `### ${i + 1}. ${c.name}\n\n`;
    md += `| Metric | Value |\n|---|---|\n`;
    md += `| Firms affected | **${affected} of ${TOTAL}** (${affectedPct}) |\n`;
    md += `| FAIL | ${c.failCount} firms |\n`;
    md += `| WARNING | ${c.warnCount} firms |\n`;
    md += `| Risk category | ${c.category} |\n`;
    md += `| Severity | ${sev} |\n`;
    md += `| Scanner | ${c.scanner} |\n`;
    if (example) {
      const detail = String(example.detail).replace(/\|/g, '\\|').slice(0, 120);
      md += `| Example finding | \`${detail}\` |\n`;
    }
    md += '\n';
  });

  md += `---

## Top 5 Quick Wins

Checks with the highest failure rate that a typical solicitor firm can remediate without specialist knowledge. All five can be resolved through web server or DNS configuration — no application code changes required.

`;

  const quickWinRemediation = {
    'Referrer-Policy':           'Add `Referrer-Policy: strict-origin-when-cross-origin` to web server config or hosting panel.',
    'X-Frame-Options':           'Add `X-Frame-Options: SAMEORIGIN` to web server config.',
    'X-Content-Type-Options':    'Add `X-Content-Type-Options: nosniff` to web server config.',
    'HSTS':                      'Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` to web server config.',
    'Content Security Policy':   'Add a basic CSP header: `Content-Security-Policy: default-src \'self\'; script-src \'self\' \'unsafe-inline\'`.',
    'DMARC record':              'Publish a DMARC record at `_dmarc.yourdomain.com` — start with `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com`.',
    'DMARC policy':              'Upgrade DMARC policy from `p=none` to `p=quarantine` or `p=reject` after monitoring for 2–4 weeks.',
    'Cookie consent':            'Add a compliant cookie consent banner using a free tool such as CookieYes or Cookiebot.',
  };

  quickWins.forEach((c, i) => {
    const affected = both(c);
    let remedy = '';
    for (const [k, v] of Object.entries(quickWinRemediation)) {
      if (c.name.toLowerCase().includes(k.toLowerCase())) { remedy = v; break; }
    }
    md += `### ${i + 1}. ${c.name}\n\n`;
    md += `**Affected:** ${affected} of ${TOTAL} firms (${pct(affected)}) · **Category:** ${c.category} · **Severity:** ${severity(c.name)}\n\n`;
    if (remedy) md += `**Remediation:** ${remedy}\n\n`;
    md += `**Why it's a quick win:** Browser security headers and basic DNS records require no application changes — only a configuration update to the web server or DNS provider. Most hosting panels expose these settings directly.\n\n`;
  });

  md += `---

## Top 5 High-Impact Findings

Checks that contribute the greatest total loss of points across the cohort. These findings drive the largest downward pressure on cohort-wide scores and represent the highest-priority areas for improvement.

`;

  highImpact.forEach((c, i) => {
    const affected = both(c);
    const avgLostPerFirm = c.failCount > 0 ? Math.round(c.pointsLost / c.failCount) : 0;
    md += `### ${i + 1}. ${c.name}\n\n`;
    md += `| Metric | Value |\n|---|---|\n`;
    md += `| Total points lost across cohort | **${c.pointsLost} pts** |\n`;
    md += `| Firms affected | ${affected} (${pct(affected)}) |\n`;
    md += `| Avg points lost per affected firm | ~${avgLostPerFirm} pts |\n`;
    md += `| Category | ${c.category} |\n`;
    md += `| Severity | ${severity(c.name)} |\n`;
    md += '\n';
  });

  md += `---

## Methodology Notes

- Analysis uses the most recent scan record per prospect (regeneration run ${TODAY}).
- Check names and statuses are taken directly from stored \`scanner_results\` JSON.
- "Affected" = FAIL + WARNING combined unless stated otherwise.
- Points lost are estimated from the scoring model (Security Rating v1.0, see SCORING.md).
- DMARC graduated scoring: p=reject 40 pts · p=quarantine 30 pts · p=none 20 pts · no record 0 pts.
- DKIM detection covers 10 common selectors only; true adoption may be higher than reported.

---

*Soterius Security Rating v1.0*
*Benchmark Findings 001 — North Wales Solicitors*
*Generated ${TODAY}*
`;

  fs.writeFileSync(REPORT_PATH, md, 'utf8');
  console.log(`\nReport written → ${REPORT_PATH}`);
})().catch(e => { console.error(e.message); process.exit(1); });
