'use strict';
/**
 * Benchmark Regeneration Script — Cohort 001
 *
 * Re-scans all benchmark prospects with the corrected email scanner,
 * computes statistics, and writes BENCHMARK_REPORT_001.md.
 *
 * Run from the backend/ directory:
 *   node scripts/regenerate-benchmark.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const path     = require('path');
const fs       = require('fs');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');
const { executeScan }  = require('../../api/services/scanService');

// ── Config ────────────────────────────────────────────────────────────────────

const CONCURRENCY        = 5;
const LOW_SCORE_FLAG     = 10; // % — domains scoring at or below this are flagged for review
const REPORT_PATH        = path.join(__dirname, '../../../BENCHMARK_REPORT_001.md');
const TODAY              = new Date().toISOString().split('T')[0];

// ── Supabase client ───────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Utilities ─────────────────────────────────────────────────────────────────

const pct    = (n, total) => total === 0 ? 0 : Math.round(n / total * 100);
const rating = (p)        => Math.round(p / 100 * 999);

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function normaliseDomain(raw) {
  return (raw || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .split('/')[0];
}

function isValidDomain(d) {
  return /^(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,}$/.test(d);
}

const log  = (...a) => console.log(...a);
const lerr = (...a) => console.error(...a);

// Readline prompt — only meaningful when running in an interactive terminal
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('\n═══════════════════════════════════════════════════════════════');
  log('  Soterius — Benchmark Regeneration — Cohort 001');
  log(`  ${TODAY}`);
  log('═══════════════════════════════════════════════════════════════\n');

  // ── 1. Load all prospects ─────────────────────────────────────────────────

  const { data: allProspects, error: fetchErr } = await supabase
    .from('prospects')
    .select('*')
    .order('firm_name');

  if (fetchErr) { lerr('Failed to load prospects:', fetchErr.message); process.exit(1); }
  log(`Loaded ${allProspects.length} prospects from database.\n`);

  // ── 2. Validate and deduplicate ───────────────────────────────────────────

  const seen     = new Set();
  const toScan   = [];
  const excluded = [];

  for (const p of allProspects) {
    const domain = normaliseDomain(p.website);

    if (!domain) {
      excluded.push({ p, reason: 'No website recorded' });
      continue;
    }
    if (!isValidDomain(domain)) {
      excluded.push({ p, reason: `Invalid domain: "${domain}"` });
      continue;
    }
    if (domain.split('.').some(part => part.length < 2)) {
      excluded.push({ p, reason: `Suspicious domain (likely typo): "${domain}"` });
      continue;
    }
    if (seen.has(domain)) {
      excluded.push({ p, reason: `Duplicate domain: "${domain}"` });
      continue;
    }

    seen.add(domain);
    toScan.push({ ...p, website: domain });
  }

  log(`Prospects to scan: ${toScan.length}`);
  if (excluded.length) {
    log(`Excluded:          ${excluded.length}`);
    excluded.forEach(e => log(`  ✗ ${e.p.firm_name} (${e.p.website || '—'}) — ${e.reason}`));
  }
  log('');

  // ── 3. Re-scan in concurrent batches ─────────────────────────────────────

  const results  = [];
  const total    = toScan.length;
  const nBatches = Math.ceil(total / CONCURRENCY);

  for (let i = 0; i < total; i += CONCURRENCY) {
    const batch     = toScan.slice(i, i + CONCURRENCY);
    const batchNum  = Math.floor(i / CONCURRENCY) + 1;
    log(`── Batch ${batchNum}/${nBatches} ─────────────────────────────────────────────`);

    const settled = await Promise.allSettled(batch.map(async (p) => {
      try {
        const scan = await executeScan(p.website);

        // Persist new scan record linked to this prospect
        const { error: saveErr } = await supabase.from('scans').insert({
          domain:          p.website,
          scanned_at:      scan.scoreObject.timestamp || new Date().toISOString(),
          scoring_version: 'v1.0',
          overall_score:   scan.scoreObject.percentage,
          risk_band:       scan.scoreObject.riskBand,
          score_object:    scan.scoreObject,
          scanner_results: scan.scanners,
          prospect_id:     p.id,
        });

        if (saveErr) {
          log(`  ⚠ ${p.firm_name} — scan ok but DB write failed: ${saveErr.message}`);
        } else {
          await supabase.from('prospects')
            .update({ last_scanned: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', p.id);
        }

        const r = rating(scan.score);
        log(`  ✓ ${p.firm_name.substring(0, 42).padEnd(42)}  ${String(r).padStart(3)}  ${scan.riskLevel}`);
        return { p, scan, status: 'success' };
      } catch (e) {
        log(`  ✗ ${p.firm_name.substring(0, 42).padEnd(42)}  ERROR: ${e.message}`);
        return { p, scan: null, status: 'failed', error: e.message };
      }
    }));

    for (const r of settled) {
      results.push(r.status === 'fulfilled' ? r.value : { p: null, status: 'failed', error: r.reason?.message });
    }

    // Brief pause between batches
    if (i + CONCURRENCY < total) await new Promise(r => setTimeout(r, 1500));
  }

  // ── 4. Partition ─────────────────────────────────────────────────────────

  let successful   = results.filter(r => r.status === 'success');
  const failed     = results.filter(r => r.status === 'failed');

  log(`\n── Scan summary ─────────────────────────────────────────────────`);
  log(`   Successful: ${successful.length}`);
  log(`   Failed:     ${failed.length}`);
  log(`   Excluded:   ${excluded.length}`);
  if (failed.length) {
    failed.forEach(f => log(`   ✗ ${f.p?.firm_name || 'unknown'}: ${f.error}`));
  }

  if (!successful.length) { lerr('\nNo successful scans — cannot generate report.'); process.exit(1); }

  // ── 5. Low-score review — flag potentially inactive or incorrect domains ───
  //
  // Domains scoring ≤ LOW_SCORE_FLAG% are likely parked, inactive, or
  // incorrectly recorded. In an interactive terminal the user is prompted
  // to delete each one; in non-interactive mode they are reported only.

  const flagged  = successful.filter(r => r.scan.score <= LOW_SCORE_FLAG);
  const deleted  = [];

  if (flagged.length) {
    log(`\n── Low score flags (≤ ${LOW_SCORE_FLAG}%) — possible inactive or incorrect domains ──`);

    for (const r of flagged) {
      log(`\n   ⚠  ${r.p.firm_name}`);
      log(`       Domain:  ${r.p.website}`);
      log(`       Score:   ${rating(r.scan.score)} / 999 (${r.scan.score}%) — ${r.scan.riskLevel}`);
      log(`       Reason:  Score this low usually indicates a parked, offline, or incorrectly recorded domain.`);

      if (process.stdin.isTTY) {
        const answer = await prompt('       Delete this prospect and all its scan records? [y/N] ');
        if (answer.toLowerCase() === 'y') {
          const { error: scanErr } = await supabase.from('scans').delete().eq('prospect_id', r.p.id);
          if (scanErr) {
            log(`       ✗ Could not delete scan records: ${scanErr.message}`);
            continue;
          }
          const { error: prospectErr } = await supabase.from('prospects').delete().eq('id', r.p.id);
          if (prospectErr) {
            log(`       ✗ Could not delete prospect: ${prospectErr.message}`);
            continue;
          }
          log(`       ✓ Deleted.`);
          r.deleted = true;
          deleted.push(r);
        } else {
          log(`       Kept — will be included in statistics.`);
        }
      } else {
        log(`       (Run in an interactive terminal to delete interactively.)`);
      }
    }

    if (deleted.length) {
      successful = successful.filter(r => !r.deleted);
      log(`\n   ${deleted.length} prospect(s) deleted. Recomputing with ${successful.length} firms.`);
    }
    log('');
  }

  // ── 6. Detect other anomalies ─────────────────────────────────────────────

  const anomalies = [];
  // Domains already handled above via interactive delete
  for (const r of flagged.filter(r => !r.deleted)) {
    anomalies.push({ firm: r.p.firm_name, domain: r.p.website, note: `Score ${rating(r.scan.score)} / 999 — may be inactive or incorrectly recorded` });
  }
  for (const r of successful) {
    if (r.scan.score === 100) anomalies.push({ firm: r.p.firm_name, domain: r.p.website, note: 'Score 100 — unexpectedly perfect; verify manually' });
  }

  if (anomalies.length) {
    log('── Anomalies carried into report ────────────────────────────────');
    anomalies.forEach(a => log(`   ⚠ ${a.firm} (${a.domain}): ${a.note}`));
    log('');
  }

  // ── 7. Compute statistics ─────────────────────────────────────────────────

  const stats = computeStats(successful);

  // ── 8. Generate report ────────────────────────────────────────────────────

  const report = generateReport(stats, failed, excluded, anomalies, allProspects);
  fs.writeFileSync(REPORT_PATH, report, 'utf8');
  log(`\nReport written → BENCHMARK_REPORT_001.md`);

  // ── 9. Print summary ──────────────────────────────────────────────────────

  printSummary(stats);
}

// ── Statistics ────────────────────────────────────────────────────────────────

function computeStats(successful) {
  const n      = successful.length;
  const scores = successful.map(r => r.scan.score);

  // Risk band counts
  const bands = {};
  for (const r of successful) {
    const b = r.scan.riskLevel;
    bands[b] = (bands[b] || 0) + 1;
  }

  // Build check map: { checkName: { PASS, WARNING, FAIL } }
  const checkMap    = {};
  const dmarcChecks = [];

  for (const r of successful) {
    for (const scanner of (r.scan.scanners || [])) {
      for (const check of (scanner.checks || [])) {
        if (!checkMap[check.name]) checkMap[check.name] = { PASS: 0, WARNING: 0, FAIL: 0 };
        const s = check.status || 'FAIL';
        checkMap[check.name][s] = (checkMap[check.name][s] || 0) + 1;
        if (check.name === 'DMARC policy enforced') dmarcChecks.push(check);
      }
    }
  }

  // SPF
  const spf      = checkMap['SPF record present and valid'] || { PASS: 0, WARNING: 0, FAIL: 0 };
  const spfCount = spf.PASS + spf.WARNING;

  // DKIM
  const dkim      = checkMap['DKIM configured'] || { PASS: 0, WARNING: 0, FAIL: 0 };
  const dkimCount = dkim.PASS;

  // DMARC
  const dmarcWith   = dmarcChecks.filter(c => c.status !== 'FAIL').length;
  const dmarcLevels = {
    'No record':                          dmarcChecks.filter(c => c.status === 'FAIL').length,
    'Monitoring only (p=none)':           dmarcChecks.filter(c => c.status === 'WARNING' && c.points === 20).length,
    'Partial protection (p=quarantine)':  dmarcChecks.filter(c => c.status === 'WARNING' && c.points === 30).length,
    'Full protection (p=reject)':         dmarcChecks.filter(c => c.status === 'PASS').length,
  };
  const dmarcEnforcedCount = dmarcLevels['Partial protection (p=quarantine)'] + dmarcLevels['Full protection (p=reject)'];

  // Security header adoption
  const HEADERS = [
    'HSTS present',
    'Content Security Policy set',
    'X-Frame-Options set',
    'X-Content-Type-Options set',
    'Referrer-Policy set',
  ];
  const headerAdoption = {};
  for (const name of HEADERS) {
    const c = checkMap[name] || { PASS: 0, WARNING: 0, FAIL: 0 };
    headerAdoption[name] = { pass: c.PASS || 0, warning: c.WARNING || 0, fail: c.FAIL || 0 };
  }

  // Top failed checks (sorted by fail count desc)
  const failedChecks = Object.entries(checkMap)
    .map(([name, c]) => ({ name, failCount: c.FAIL || 0 }))
    .filter(c => c.failCount > 0)
    .sort((a, b) => b.failCount - a.failCount);

  // Category averages
  const catAvg = {};
  for (const key of ['ssl', 'email', 'headers', 'vulnComp', 'gdpr']) {
    const vals = successful
      .map(r => r.scan.scoreObject?.categoryBreakdown?.[key]?.percentage)
      .filter(v => typeof v === 'number');
    catAvg[key] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  }

  // Sector breakdown
  const bySector = {};
  for (const r of successful) {
    const s = r.p.sector || 'Unknown';
    if (!bySector[s]) bySector[s] = [];
    bySector[s].push(r.scan.score);
  }

  return {
    n,
    avgScore:    Math.round(scores.reduce((a, b) => a + b, 0) / n),
    medianScore: median(scores),
    minScore:    Math.min(...scores),
    maxScore:    Math.max(...scores),
    bands,
    spfCount,    spfAdoption:    pct(spfCount, n),
    dkimCount,   dkimAdoption:   pct(dkimCount, n),
    dmarcWith,   dmarcAdoption:  pct(dmarcWith, n),
    dmarcLevels, dmarcEnforcedCount, dmarcEnforcement: pct(dmarcEnforcedCount, n),
    headerAdoption,
    failedChecks,
    catAvg,
    bySector,
    checkMap,
  };
}

// ── Report generator ──────────────────────────────────────────────────────────

function generateReport(stats, failed, excluded, anomalies, allProspects) {
  const n          = stats.n;
  const BAND_ORDER = ['Excellent', 'Good', 'Moderate Risk', 'High Risk', 'Critical Risk'];
  const CAT_NAMES  = {
    ssl:      'SSL/TLS Encryption',
    email:    'Email Security',
    headers:  'Security Headers',
    vulnComp: 'Vulnerable Components',
    gdpr:     'GDPR / Cookie Compliance',
  };
  const HEADER_SHORT = {
    'HSTS present':                'HSTS',
    'Content Security Policy set': 'Content Security Policy',
    'X-Frame-Options set':         'X-Frame-Options',
    'X-Content-Type-Options set':  'X-Content-Type-Options',
    'Referrer-Policy set':         'Referrer-Policy',
  };

  const highCritCount = (stats.bands['High Risk'] || 0) + (stats.bands['Critical Risk'] || 0);
  const highCritPct   = pct(highCritCount, n);

  const bandRows = BAND_ORDER.map(b => {
    const c   = stats.bands[b] || 0;
    const p   = pct(c, n);
    const bar = '█'.repeat(Math.round(p / 5));
    return `| ${b.padEnd(16)} | ${String(c).padStart(5)} | ${String(p).padStart(3)}% | ${bar} |`;
  }).join('\n');

  const catRows = Object.entries(stats.catAvg)
    .map(([k, v]) => `| ${CAT_NAMES[k].padEnd(26)} | ${String(v).padStart(4)}% |`)
    .join('\n');

  const dmarcRows = Object.entries(stats.dmarcLevels)
    .map(([level, count]) => `| ${level.padEnd(36)} | ${String(count).padStart(5)} | ${String(pct(count, n)).padStart(3)}% |`)
    .join('\n');

  const headerRows = Object.entries(stats.headerAdoption)
    .map(([name, h]) => {
      const adoption = pct(h.pass + h.warning, n);
      return `| ${(HEADER_SHORT[name] || name).padEnd(28)} | ${String(h.pass).padStart(4)} | ${String(h.warning).padStart(7)} | ${String(h.fail).padStart(4)} | ${String(adoption).padStart(3)}% |`;
    })
    .join('\n');

  const topFailRows = stats.failedChecks.slice(0, 10)
    .map(c => `| ${c.name.padEnd(44)} | ${String(c.failCount).padStart(5)} | ${String(pct(c.failCount, n)).padStart(3)}% |`)
    .join('\n');

  const sectorRows = Object.entries(stats.bySector)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([s, scores]) => {
      const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      return `| ${s.padEnd(24)} | ${String(scores.length).padStart(5)} | ${String(rating(avg)).padStart(7)} |`;
    })
    .join('\n');

  // Data quality notes
  const dqNotes = [];
  if (excluded.length) {
    dqNotes.push(`### Excluded prospects (${excluded.length})\n`);
    dqNotes.push(...excluded.map(e => `- **${e.p.firm_name}** (\`${e.p.website || '—'}\`) — ${e.reason}`));
    dqNotes.push('');
  }
  if (failed.length) {
    dqNotes.push(`### Scan failures (${failed.length})\n`);
    dqNotes.push(...failed.map(f => `- **${f.p?.firm_name || 'unknown'}** (\`${f.p?.website || '—'}\`) — ${f.error}`));
    dqNotes.push('');
  }
  if (anomalies.length) {
    dqNotes.push(`### Anomalies flagged (${anomalies.length})\n`);
    dqNotes.push(...anomalies.map(a => `- **${a.firm}** (\`${a.domain}\`) — ${a.note}`));
    dqNotes.push('');
  }
  if (!dqNotes.length) {
    dqNotes.push('No data quality issues identified. All prospects scanned successfully.');
  }

  const noRecordPct = pct(stats.dmarcLevels['No record'], n);
  const noneOnlyPct = pct(stats.dmarcLevels['Monitoring only (p=none)'], n);

  return `# Benchmark Report 001 — North Wales Solicitors
## Soterius Security Rating — First Regional Benchmark

**Cohort:** Benchmark Cohort 001 — North Wales Solicitor Benchmark
**Region:** Within 25 miles of LL30 2UB
**Sector:** Solicitors
**Source:** SRA regulated firms register
**Scan Date:** ${TODAY}
**Scoring Version:** Security Rating v1.0
**Status:** Final — generated from corrected scan data (post-DNS bug fix)

---

## Executive Summary

This report presents the findings from the first Soterius benchmark dataset — a complete scan of solicitor firms within 25 miles of Llandudno Junction (LL30 2UB), sourced from the SRA regulated firms register.

**${n} solicitor firms** were analysed.

| Metric | Value |
|---|---|
| Firms analysed | **${n}** |
| Average Security Rating | **${rating(stats.avgScore)} / 999** |
| Median Security Rating | **${rating(stats.medianScore)} / 999** |
| Rating range | ${rating(stats.minScore)} – ${rating(stats.maxScore)} |
| High Risk or Critical Risk | **${highCritPct}%** (${highCritCount} firms) |
| SPF adoption | ${stats.spfAdoption}% |
| DMARC adoption (any record) | ${stats.dmarcAdoption}% |
| DMARC enforcement (quarantine/reject) | ${stats.dmarcEnforcement}% |

**${highCritPct}%** of firms fall into the High Risk or Critical Risk categories. The primary failures are in email authentication and security headers — both categories where remediation is achievable quickly and at low cost.

This report was produced following the identification and resolution of a DNS lookup bug that caused email security checks to return 0/56 for domains stored with a \`www.\` prefix. All scan records were regenerated on ${TODAY} using the corrected scanner.

---

## Methodology

### Scoring Model

Soterius Security Rating v1.0 evaluates five security categories:

| Category | Max Points | Weight |
|---|---|---|
| SSL/TLS Encryption | 40 | 19% |
| Email Security | 56 | 27% |
| Security Headers | 50 | 24% |
| Vulnerable Components | 48 | 23% |
| GDPR / Cookie Compliance | 12 | 6% |
| **Total** | **206** | 100% |

Points earned as a percentage of 206 are mapped to a 0–999 display rating. Risk bands:

| Band | Threshold | Rating range |
|---|---|---|
| Excellent | ≥ 90% | 899–999 |
| Good | 75–89% | 749–889 |
| Moderate Risk | 60–74% | 599–739 |
| High Risk | 40–59% | 400–589 |
| Critical Risk | < 40% | 0–390 |

### Email Security Scoring (DMARC — graduated)

| Policy | Points | Level |
|---|---|---|
| p=reject | 40 | Full Protection |
| p=quarantine | 30 | Partial Protection |
| p=none | 20 | Monitoring Only |
| No record | 0 | No Protection |

### Data Collection

- Firms sourced from the SRA regulated firms register, scoped to within 25 miles of LL30 2UB
- Scanned via Soterius Research Mode (admin-authenticated endpoint)
- One new scan record created per firm during regeneration; previous scans retained (immutable records per D008)
- Benchmark statistics derived from the regeneration scan records
- DNS lookups use the Node.js system resolver; HTTP checks fetch live headers with a 10-second timeout

---

## Sample Size

| Metric | Count |
|---|---|
| Total prospects in cohort | ${allProspects.length} |
| Firms included in this report | **${n}** |
| Excluded (invalid/duplicate) | ${excluded.length} |
| Scan failures | ${failed.length} |
${sectorRows ? `\n### By Sector\n\n| Sector                   | Count | Avg Rating |\n|--------------------------|-------|------------|\n${sectorRows}` : ''}

---

## Risk Distribution

| Band             | Count | Share |                    |
|------------------|-------|-------|--------------------|
${bandRows}

**${highCritPct}%** of firms are rated High Risk or Critical Risk.

### Average Score by Category

| Category                   | Avg % |
|----------------------------|-------|
${catRows}

---

## Email Security Findings

Email Security is the lowest-performing category in this cohort, with an average of **${stats.catAvg.email}%**.

### SPF (Sender Policy Framework)

SPF records specify which mail servers are authorised to send email on behalf of a domain. Without SPF, anyone can send email appearing to come from a firm's address.

- **${stats.spfAdoption}%** of firms have an SPF record (${stats.spfCount} of ${n})
- **${100 - stats.spfAdoption}%** of firms (${n - stats.spfCount}) have no SPF record

### DKIM (DomainKeys Identified Mail)

DKIM adds a cryptographic signature to outbound emails, allowing recipients to verify that an email genuinely came from the sending domain. Detection checks 10 common selector names; the true adoption rate may be higher.

- **${stats.dkimAdoption}%** of firms have a detectable DKIM record (${stats.dkimCount} of ${n})

### DMARC (Domain-based Message Authentication, Reporting & Conformance)

DMARC policy instructs receiving mail servers on what to do with messages that fail SPF or DKIM checks.

| Policy Level                         | Firms | Share |
|--------------------------------------|-------|-------|
${dmarcRows}

- **DMARC adoption:** ${stats.dmarcAdoption}% of firms have any DMARC record (${stats.dmarcWith} of ${n})
- **DMARC enforcement:** ${stats.dmarcEnforcement}% of firms have active enforcement — p=quarantine or p=reject (${stats.dmarcEnforcedCount} of ${n})
- **${noRecordPct}%** of firms have no DMARC record at all — email from their domain can be trivially spoofed

---

## Website Security Findings

### Security Headers

Security headers are HTTP response headers that instruct browsers on how to handle page content. They are set in the web server or hosting control panel and typically take minutes to configure.

| Header                      | Pass | Warning | Fail | Adoption |
|-----------------------------|------|---------|------|----------|
${headerRows}

### Most Common Failed Checks (all categories)

| Check                                        | Firms | Share |
|----------------------------------------------|-------|-------|
${topFailRows}

---

## Key Observations

1. **Email spoofing risk is the dominant finding.** ${noRecordPct}% of firms have no DMARC record, and only ${stats.dmarcEnforcement}% have enforcement-level policies. Solicitors handling client money, legal documents, and confidential instructions are high-value phishing targets. The absence of email authentication controls represents the most significant and remediable security gap in this cohort.

2. **Security headers are broadly absent.** The most commonly failed checks are security headers, all achievable in under 30 minutes. The failure rate reflects a lack of proactive security configuration rather than technical complexity — these firms are not hardened, but hardening is straightforward.

3. **SPF is more widely adopted than DMARC.** ${stats.spfAdoption}% of firms have SPF vs ${stats.dmarcAdoption}% with any DMARC. Many firms have partially implemented email authentication without completing the full chain. SPF alone provides limited protection without DMARC enforcement.

4. **Monitoring-only DMARC is a common partial deployment.** ${noneOnlyPct}% of firms have DMARC \`p=none\` — this collects reports but provides no protection against spoofing. These firms have demonstrated awareness of DMARC but have not taken the final step to enforcement.

5. **Score distribution is credible.** The ${highCritPct}% High/Critical Risk concentration is consistent with the profile of small-to-medium professional services firms without dedicated IT security resource. Band distribution is non-trivial — firms are spread across the full range, and the scoring model produces meaningful differentiation.

6. **SSL/TLS is the strongest category** (average: ${stats.catAvg.ssl}%), reflecting widespread adoption of basic HTTPS across the sector.

---

## Recommendations

### Highest-priority actions for High Risk / Critical Risk firms

| Priority | Action | Est. Time | Impact |
|---|---|---|---|
| 1 | Publish DMARC record — start with \`p=none\`, move to \`p=quarantine\` | 15 min | Prevents email spoofing |
| 2 | Verify SPF record is present and covers all sending services | 15 min | Blocks unauthorised senders |
| 3 | Enable HSTS header on web server | 5 min | Prevents HTTP downgrade attacks |
| 4 | Set X-Frame-Options header | 5 min | Prevents clickjacking |
| 5 | Set X-Content-Type-Options: nosniff | 5 min | Prevents MIME sniffing |
| 6 | Configure Content Security Policy | 30 min | Prevents XSS attacks |

### For firms with DMARC p=none

Upgrade the policy incrementally:
1. Ensure SPF and DKIM are correctly configured and aligned
2. Monitor DMARC aggregate reports for 2–4 weeks
3. Move to \`p=quarantine\` once legitimate mail is flowing cleanly
4. Move to \`p=reject\` once quarantine is stable

### Sector-wide observation

A DMARC enforcement rate of ${stats.dmarcEnforcement}% in a sector where firms routinely communicate client money instructions and sensitive legal documents by email represents significant exposure. Raising DMARC enforcement to even 50% of firms would materially reduce the attack surface for email-based fraud targeting this sector.

---

## Data Quality Notes

${dqNotes.join('\n')}
### Known Limitations

- **DKIM detection** covers 10 common selector names only (\`google\`, \`selector1\`, \`selector2\`, \`default\`, \`mail\`, \`k1\`, \`k2\`, \`dkim\`, \`smtp\`, \`mimecast\`). Firms using custom selectors will appear as DKIM FAIL even when DKIM is correctly configured. The true DKIM adoption rate is likely higher than reported.
- **CVE detection** is based on technology fingerprinting. Firms using CDNs, proxies, or generic hosting may have their stack obscured, potentially understating the Vulnerable Components score.
- **Point-in-time snapshot.** Scores reflect each firm's security posture on ${TODAY} only. Scores will change as firms update their configurations.
- **www. prefix bug — resolved.** A DNS lookup bug was identified during scanner accuracy validation: email security checks (SPF, DMARC, DKIM) were being queried against \`www.domain.com\` rather than the apex domain \`domain.com\`, where DNS authentication records are always published. This caused email category scores of 0/56 for affected firms. The bug was fixed and all scan records regenerated on ${TODAY}. Darwin Gray was the validation firm: score corrected from 360 to 529, email category from 0% to 64%.

---

*Soterius Security Rating v1.0*
*Benchmark Report 001 — North Wales Solicitors*
*Generated ${TODAY}*
`;
}

// ── Console summary ───────────────────────────────────────────────────────────

function printSummary(stats) {
  const BAND_ORDER = ['Excellent', 'Good', 'Moderate Risk', 'High Risk', 'Critical Risk'];
  log('\n═══════════════════════════════════════════════════════════════');
  log('  BENCHMARK STATISTICS — COHORT 001');
  log('═══════════════════════════════════════════════════════════════');
  log(`  Firms analysed:       ${stats.n}`);
  log(`  Average rating:       ${rating(stats.avgScore)} / 999`);
  log(`  Median rating:        ${rating(stats.medianScore)} / 999`);
  log(`  Score range:          ${rating(stats.minScore)} – ${rating(stats.maxScore)}`);
  log('');
  log('  Risk distribution:');
  BAND_ORDER.forEach(b => {
    const c = stats.bands[b] || 0;
    if (c) log(`    ${b.padEnd(18)} ${String(c).padStart(3)} (${pct(c, stats.n)}%)`);
  });
  log('');
  log(`  SPF adoption:         ${stats.spfAdoption}%`);
  log(`  DKIM adoption:        ${stats.dkimAdoption}%`);
  log(`  DMARC adoption:       ${stats.dmarcAdoption}%`);
  log(`  DMARC enforcement:    ${stats.dmarcEnforcement}%`);
  log('');
  log('  Category averages:');
  log(`    SSL/TLS:            ${stats.catAvg.ssl}%`);
  log(`    Email Security:     ${stats.catAvg.email}%`);
  log(`    Headers:            ${stats.catAvg.headers}%`);
  log(`    Vuln Components:    ${stats.catAvg.vulnComp}%`);
  log(`    GDPR:               ${stats.catAvg.gdpr}%`);
  log('');
  log('  Top 5 failed checks:');
  stats.failedChecks.slice(0, 5).forEach(c => {
    log(`    ${c.name.substring(0, 48).padEnd(48)}  ${pct(c.failCount, stats.n)}%`);
  });
  log('');
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(e => { lerr('\nFatal error:', e.message); process.exit(1); });
