'use strict';
require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs');
const path = require('node:path');

const IF001_SECTXT_RUN_ID  = 'bed70595-6142-4a31-98be-1ca9460e3ffc';
const IF001_SECHDR_RUN_ID  = 'e4ef81cf-ab69-46c5-a586-0e7868576067';
const MANIFEST_PATH = path.join(__dirname, 'cohort-manifest.json');
const BATCH = 350;
const PAGE  = 1000;

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const firms    = manifest.firms;
  const domains  = firms.map(f => f.domain);
  const nameMap  = new Map(firms.map(f => [f.domain, f.firm_name ?? f.domain]));
  console.log(`Loaded ${domains.length} domains from manifest`);

  async function fetchPaged(buildQuery) {
    const all = [];
    let from = 0;
    for (;;) {
      const { data, error } = await buildQuery(from, from + PAGE - 1);
      if (error) throw new Error(`fetchPaged: ${error.message}`);
      all.push(...(data ?? []));
      if ((data ?? []).length < PAGE) break;
      from += PAGE;
    }
    return all;
  }

  async function fetchByDomains(table, cols) {
    const all = [];
    for (let i = 0; i < domains.length; i += BATCH) {
      const batch = domains.slice(i, i + BATCH);
      const rows = await fetchPaged((from, to) =>
        supabase.from(table).select(cols).in('domain', batch).range(from, to)
      );
      all.push(...rows);
    }
    return all;
  }

  // Keep only most-recent row per domain (dedup pilot vs full cohort overlap in v0 tables)
  function latestPerDomain(rows, keyField = 'domain') {
    const map = new Map();
    for (const row of rows) {
      const key = row[keyField];
      const ex  = map.get(key);
      if (!ex || row.collected_at > ex.collected_at) map.set(key, row);
    }
    return map;
  }

  // --- V0 signals ---
  console.log('Fetching SPF...');
  const spfMap = latestPerDomain(
    await fetchByDomains('signal_facts_spf', 'domain,spf_present,collected_at')
  );

  console.log('Fetching DKIM...');
  const dkimMap = latestPerDomain(
    await fetchByDomains('signal_facts_dkim', 'domain,dkim_present,collected_at')
  );

  console.log('Fetching DMARC...');
  const dmarcMap = latestPerDomain(
    await fetchByDomains('signal_facts_dmarc', 'domain,dmarc_present,collected_at')
  );

  console.log('Fetching MTA-STS...');
  const mtastsMap = latestPerDomain(
    await fetchByDomains('signal_facts_mtasts', 'domain,dns_sts_present,collected_at')
  );

  console.log('Fetching TLS-RPT...');
  const tlsrptMap = latestPerDomain(
    await fetchByDomains('signal_facts_tlsrpt', 'domain,dns_tlsrpt_present,collected_at')
  );

  console.log('Fetching DNSSEC...');
  const dnssecMap = latestPerDomain(
    await fetchByDomains('signal_facts_dnssec', 'domain,dns_ds_present,collected_at')
  );

  console.log('Fetching CAA...');
  const caaMap = latestPerDomain(
    await fetchByDomains('signal_facts_caa', 'domain,dns_caa_present,collected_at')
  );

  // --- Security.txt v1 ---
  console.log('Fetching Security.txt...');
  const sectxtRows = await fetchPaged((from, to) =>
    supabase.from('signal_securitytxt_v1')
      .select('domain,file_state')
      .eq('run_id', IF001_SECTXT_RUN_ID)
      .range(from, to)
  );
  const sectxtMap = new Map(sectxtRows.map(r => [r.domain, r.file_state]));
  console.log(`  SecurityTXT rows: ${sectxtRows.length}`);

  // --- Security Headers v1 ---
  // "Present" = at least one of HSTS, XCTO, XFO, CSP is present
  console.log('Fetching Security Headers - key header presence...');
  const KEY_HEADERS = [
    'strict_transport_security',
    'x_content_type_options',
    'x_frame_options',
    'content_security_policy',
  ];
  const secHdrPresent = new Set();
  for (const hdr of KEY_HEADERS) {
    const rows = await fetchPaged((from, to) =>
      supabase.from('signal_securityheaders_v1')
        .select('domain')
        .eq('run_id', IF001_SECHDR_RUN_ID)
        .eq(`header_inventory->${hdr}->>present`, 'true')
        .range(from, to)
    );
    for (const r of rows) secHdrPresent.add(r.domain);
    console.log(`  ${hdr}: ${rows.length} domains`);
  }
  console.log(`  Total domains with ≥1 key security header: ${secHdrPresent.size}`);

  // --- Build per-domain signal matrix ---
  const domainData = [];
  for (const domain of domains) {
    const signals = {
      spf:    spfMap.get(domain)?.spf_present    === true,
      dkim:   dkimMap.get(domain)?.dkim_present  === true,
      dmarc:  dmarcMap.get(domain)?.dmarc_present === true,
      mtasts: mtastsMap.get(domain)?.dns_sts_present === true,
      tlsrpt: tlsrptMap.get(domain)?.dns_tlsrpt_present === true,
      dnssec: dnssecMap.get(domain)?.dns_ds_present === true,
      caa:    caaMap.get(domain)?.dns_caa_present === true,
      sectxt: (sectxtMap.get(domain) ?? '').startsWith('PRESENT'),
      sechdr: secHdrPresent.has(domain),
    };
    const positiveCount = Object.values(signals).filter(Boolean).length;
    domainData.push({
      domain,
      name: nameMap.get(domain) ?? domain,
      signals,
      positiveCount,
    });
  }

  // Sort ascending by count, then domain for stable tiebreaking
  domainData.sort((a, b) => a.positiveCount - b.positiveCount || a.domain.localeCompare(b.domain));

  const bottom50 = domainData.slice(0, 50);

  // Distribution across full cohort
  const dist = {};
  for (const d of domainData) {
    const k = String(d.positiveCount);
    dist[k] = (dist[k] ?? 0) + 1;
  }

  // Distribution within bottom 50
  const bottom50Dist = {};
  for (const d of bottom50) {
    const k = String(d.positiveCount);
    bottom50Dist[k] = (bottom50Dist[k] ?? 0) + 1;
  }

  // Observable characteristics: per-signal absence counts within bottom 50
  const absenceCounts = {};
  const SIGNAL_KEYS = ['spf','dkim','dmarc','mtasts','tlsrpt','dnssec','caa','sectxt','sechdr'];
  for (const k of SIGNAL_KEYS) absenceCounts[k] = 0;
  for (const d of bottom50) {
    for (const k of SIGNAL_KEYS) {
      if (!d.signals[k]) absenceCounts[k]++;
    }
  }

  // Write JSON for reference
  const jsonPath = path.join(__dirname, 'lowest-adoption-raw.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ bottom50, dist, bottom50Dist, absenceCounts }, null, 2));
  console.log(`Written: ${jsonPath}`);

  // Write markdown
  const md = buildMarkdown(bottom50, dist, bottom50Dist, absenceCounts, domains.length);
  const mdPath = path.join(__dirname, '../../../IF001_LOWEST_SIGNAL_ADOPTION_GROUP.md');
  fs.writeFileSync(mdPath, md);
  console.log(`Written: ${mdPath}`);
}

const SIGNAL_LABELS = {
  spf:    'SPF',
  dkim:   'DKIM',
  dmarc:  'DMARC',
  mtasts: 'MTA-STS',
  tlsrpt: 'TLS-RPT',
  dnssec: 'DNSSEC',
  caa:    'CAA',
  sectxt: 'Security.txt',
  sechdr: 'Security Headers',
};
const SIGNAL_KEYS = ['spf','dkim','dmarc','mtasts','tlsrpt','dnssec','caa','sectxt','sechdr'];

function buildMarkdown(bottom50, dist, bottom50Dist, absenceCounts, totalDomains) {
  const lines = [];

  lines.push('# IF-001 — Lowest Signal Adoption Group');
  lines.push('');
  lines.push('**Cohort:** IF-001 — FCA Investment Firms (Full Cohort, 1,893 domains)');
  lines.push('**Collection date:** 2026-06-17');
  lines.push('**Report produced:** 2026-06-17');
  lines.push('**Status:** Observable evidence only. No scores, risk ratings, or assessments.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Signal Definitions');
  lines.push('');
  lines.push('A signal is counted as **positive** if the following observable state is true:');
  lines.push('');
  lines.push('| Signal | Positive condition |');
  lines.push('|---|---|');
  lines.push('| SPF | `spf_present = true` |');
  lines.push('| DKIM | `dkim_present = true` (at least one selector detected) |');
  lines.push('| DMARC | `dmarc_present = true` |');
  lines.push('| MTA-STS | `dns_sts_present = true` |');
  lines.push('| TLS-RPT | `dns_tlsrpt_present = true` |');
  lines.push('| DNSSEC | `dns_ds_present = true` |');
  lines.push('| CAA | `dns_caa_present = true` |');
  lines.push('| Security.txt | `file_state` begins with `PRESENT` |');
  lines.push('| Security Headers | At least one of HSTS, X-Content-Type-Options, X-Frame-Options, or CSP present |');
  lines.push('');
  lines.push('**Positive Signal Count:** sum of positive signals per domain. Maximum: 9. Minimum: 0.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Lowest 50 Firms by Positive Signal Count');
  lines.push('');

  // Header row
  lines.push('| # | Firm Name | Domain | Count | Signals Present | Signals Absent |');
  lines.push('|---|---|---|---|---|---|');

  for (let i = 0; i < bottom50.length; i++) {
    const d = bottom50[i];
    const present = SIGNAL_KEYS.filter(k => d.signals[k]).map(k => SIGNAL_LABELS[k]).join(', ') || '—';
    const absent  = SIGNAL_KEYS.filter(k => !d.signals[k]).map(k => SIGNAL_LABELS[k]).join(', ') || '—';
    const name = d.name.replace(/\|/g, '\\|');
    lines.push(`| ${i + 1} | ${name} | ${d.domain} | ${d.positiveCount} | ${present} | ${absent} |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Distribution Analysis');
  lines.push('');
  lines.push('### Positive Signal Count — Bottom 50 firms');
  lines.push('');
  lines.push('| Signal count | Firms in bottom 50 |');
  lines.push('|---|---|');
  for (let c = 0; c <= 4; c++) {
    const count = bottom50Dist[String(c)] ?? 0;
    if (c === 4) {
      lines.push(`| 4+ | ${count} |`);
    } else {
      lines.push(`| ${c} | ${count} |`);
    }
  }

  lines.push('');
  lines.push('### Full cohort reference distribution (1,893 domains)');
  lines.push('');
  lines.push('| Signal count | Domains | % of cohort |');
  lines.push('|---|---|---|');
  const sortedCounts = Object.keys(dist).map(Number).sort((a, b) => a - b);
  for (const c of sortedCounts) {
    const n = dist[String(c)];
    const pct = ((n / totalDomains) * 100).toFixed(1);
    lines.push(`| ${c} | ${n} | ${pct}% |`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Cohort Characteristics');
  lines.push('');
  lines.push('Observable characteristics of the bottom 50 group. No inferences about risk, severity, or intent are made.');
  lines.push('');

  // Per-signal absence rates within bottom 50
  lines.push('### Per-signal absence within the bottom 50');
  lines.push('');
  lines.push('| Signal | Absent in bottom 50 | % of bottom 50 |');
  lines.push('|---|---|---|');
  for (const k of SIGNAL_KEYS) {
    const n = absenceCounts[k];
    const pct = ((n / 50) * 100).toFixed(0);
    lines.push(`| ${SIGNAL_LABELS[k]} | ${n}/50 | ${pct}% |`);
  }

  // Signal-level observations
  const zeroCount  = bottom50Dist['0'] ?? 0;
  const oneCount   = bottom50Dist['1'] ?? 0;
  const twoCount   = bottom50Dist['2'] ?? 0;

  lines.push('');
  lines.push('### Observable patterns');
  lines.push('');

  if (zeroCount > 0) {
    lines.push(`- **${zeroCount} firms** in the bottom 50 have zero positive signals across all 9 signal checks.`);
  }
  if (oneCount > 0) {
    const oneDomains = bottom50.filter(d => d.positiveCount === 1);
    // What signal is most common among 1-signal firms?
    const sigFreq = {};
    for (const d of oneDomains) {
      const present = SIGNAL_KEYS.filter(k => d.signals[k]);
      for (const k of present) sigFreq[k] = (sigFreq[k] ?? 0) + 1;
    }
    const topSig = Object.entries(sigFreq).sort((a, b) => b[1] - a[1])[0];
    const topSigLabel = topSig ? `${SIGNAL_LABELS[topSig[0]]} (${topSig[1]} firms)` : 'none';
    lines.push(`- **${oneCount} firms** have exactly 1 positive signal. Most common single signal present: ${topSigLabel}.`);
  }
  if (twoCount > 0) {
    lines.push(`- **${twoCount} firms** have exactly 2 positive signals.`);
  }

  // TLS-RPT observation
  const tlsrptAbsent = absenceCounts['tlsrpt'];
  if (tlsrptAbsent === 50) {
    lines.push('- **TLS-RPT is absent across all 50 firms.** This is consistent with the full cohort result (0% adoption in IF-001).`');
  }

  // Security headers observation
  const sechdrAbsent = absenceCounts['sechdr'];
  lines.push(`- **Security Headers absent in ${sechdrAbsent}/50 firms** (${((sechdrAbsent/50)*100).toFixed(0)}%). For comparison, security header adoption in the full IF-001 cohort is 54.4% (HSTS) to 26.5% (CSP).`);

  // DMARC observation
  const dmarcAbsent = absenceCounts['dmarc'];
  lines.push(`- **DMARC absent in ${dmarcAbsent}/50 firms**. In the full IF-001 cohort, DMARC adoption is 73.6%.`);

  // SPF observation
  const spfAbsent = absenceCounts['spf'];
  lines.push(`- **SPF absent in ${spfAbsent}/50 firms**. Note: SPF absence here includes both confirmed-absent and DNS-unknown states for these firms; the per-domain SPF status from this collection distinguishes the two.`);

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Data source: Soterius Signal Lab — IF-001 collection, 2026-06-17*');
  lines.push('*Analysis script: `backend/signal-lab/if001-full/query-lowest-adoption.js`*');
  lines.push('*Observable evidence only. No scores, grades, risk ratings, maturity assessments, or recommendations.*');

  return lines.join('\n');
}

main().catch(err => { console.error(err.stack); process.exit(1); });
