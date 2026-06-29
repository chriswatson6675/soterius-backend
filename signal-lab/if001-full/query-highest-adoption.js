'use strict';
require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs');
const path = require('node:path');

const IF001_SECTXT_RUN_ID = 'bed70595-6142-4a31-98be-1ca9460e3ffc';
const IF001_SECHDR_RUN_ID = 'e4ef81cf-ab69-46c5-a586-0e7868576067';
const MANIFEST_PATH = path.join(__dirname, 'cohort-manifest.json');
const BATCH = 350;
const PAGE  = 1000;

const SIGNAL_KEYS   = ['spf','dkim','dmarc','mtasts','tlsrpt','dnssec','caa','sectxt','sechdr'];
const SIGNAL_LABELS = {
  spf:'SPF', dkim:'DKIM', dmarc:'DMARC', mtasts:'MTA-STS', tlsrpt:'TLS-RPT',
  dnssec:'DNSSEC', caa:'CAA', sectxt:'Security.txt', sechdr:'Security Headers',
};
const KEY_HEADERS = [
  'strict_transport_security','x_content_type_options',
  'x_frame_options','content_security_policy',
];

function pct(n, d) { return d === 0 ? '0.0%' : `${((n/d)*100).toFixed(1)}%`; }

function classifyFirm(name) {
  const n = name.toLowerCase();
  if (/\bbank\b/.test(n))                       return 'Banking';
  if (/securities/.test(n))                     return 'Securities';
  if (/asset management|asset mgmt/.test(n))    return 'Asset Management';
  if (/investment management/.test(n))           return 'Investment Management';
  if (/wealth/.test(n))                         return 'Wealth Management';
  if (/private equity/.test(n))                 return 'Private Equity';
  if (/hedge/.test(n))                          return 'Hedge Fund';
  if (/advisory|advisers|advisor/.test(n))      return 'Advisory';
  if (/capital/.test(n))                        return 'Capital / Investment';
  if (/\bfunds?\b/.test(n))                     return 'Fund Management';
  if (/brokerage|broker/.test(n))               return 'Broking';
  if (/partners/.test(n))                       return 'Partnership';
  return 'Other';
}

async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const firms    = manifest.firms;
  const domains  = firms.map(f => f.domain);
  const nameMap  = new Map(firms.map(f => [f.domain, f.firm_name ?? f.domain]));
  console.log(`Loaded ${domains.length} domains`);

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

  function latestPerDomain(rows) {
    const map = new Map();
    for (const row of rows) {
      const ex = map.get(row.domain);
      if (!ex || row.collected_at > ex.collected_at) map.set(row.domain, row);
    }
    return map;
  }

  // --- V0 signals (parallel) ---
  console.log('Fetching v0 signals...');
  const [spfMap, dkimMap, dmarcMap, mtastsMap, tlsrptMap, dnssecMap, caaMap] = await Promise.all([
    fetchByDomains('signal_facts_spf',    'domain,spf_present,collected_at').then(latestPerDomain),
    fetchByDomains('signal_facts_dkim',   'domain,dkim_present,collected_at').then(latestPerDomain),
    fetchByDomains('signal_facts_dmarc',  'domain,dmarc_present,dmarc_policy,collected_at').then(latestPerDomain),
    fetchByDomains('signal_facts_mtasts', 'domain,dns_sts_present,collected_at').then(latestPerDomain),
    fetchByDomains('signal_facts_tlsrpt', 'domain,dns_tlsrpt_present,collected_at').then(latestPerDomain),
    fetchByDomains('signal_facts_dnssec', 'domain,dns_ds_present,collected_at').then(latestPerDomain),
    fetchByDomains('signal_facts_caa',    'domain,dns_caa_present,collected_at').then(latestPerDomain),
  ]);
  console.log('  v0 done');

  // --- Security.txt v1 ---
  console.log('Fetching Security.txt...');
  const sectxtRows = await fetchPaged((from, to) =>
    supabase.from('signal_securitytxt_v1')
      .select('domain,file_state')
      .eq('run_id', IF001_SECTXT_RUN_ID)
      .range(from, to)
  );
  const sectxtStateByDomain = new Map(sectxtRows.map(r => [r.domain, r.file_state]));

  // --- Security Headers: union of 4 key headers ---
  console.log('Fetching Security Headers...');
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
    console.log(`  ${hdr}: ${rows.length}`);
  }
  console.log(`  Total with ≥1 key header: ${secHdrPresent.size}`);

  // --- Per-domain matrix ---
  const domainData = [];
  for (const domain of domains) {
    const signals = {
      spf:    spfMap.get(domain)?.spf_present            === true,
      dkim:   dkimMap.get(domain)?.dkim_present          === true,
      dmarc:  dmarcMap.get(domain)?.dmarc_present        === true,
      mtasts: mtastsMap.get(domain)?.dns_sts_present     === true,
      tlsrpt: tlsrptMap.get(domain)?.dns_tlsrpt_present  === true,
      dnssec: dnssecMap.get(domain)?.dns_ds_present      === true,
      caa:    caaMap.get(domain)?.dns_caa_present        === true,
      sectxt: (sectxtStateByDomain.get(domain) ?? '').startsWith('PRESENT'),
      sechdr: secHdrPresent.has(domain),
    };
    const positiveCount = Object.values(signals).filter(Boolean).length;
    domainData.push({ domain, name: nameMap.get(domain) ?? domain, signals, positiveCount });
  }

  domainData.sort((a, b) => b.positiveCount - a.positiveCount || a.domain.localeCompare(b.domain));
  const top50 = domainData.slice(0, 50);

  // --- Full-cohort distribution ---
  const dist = {};
  for (const d of domainData) {
    const k = String(d.positiveCount);
    dist[k] = (dist[k] ?? 0) + 1;
  }

  // --- Top 50 signal concentration ---
  const top50Presence = {};
  for (const k of SIGNAL_KEYS) top50Presence[k] = top50.filter(d => d.signals[k]).length;

  // --- DMARC policy within top 50 ---
  const dmarcPolicyCounts = { reject:0, quarantine:0, none:0, absent:0 };
  for (const d of top50) {
    if (!d.signals.dmarc) { dmarcPolicyCounts.absent++; continue; }
    const policy = dmarcMap.get(d.domain)?.dmarc_policy ?? 'none';
    if (policy === 'reject')     dmarcPolicyCounts.reject++;
    else if (policy === 'quarantine') dmarcPolicyCounts.quarantine++;
    else                         dmarcPolicyCounts.none++;
  }

  // --- Security.txt file_state breakdown ---
  const sectxtStates = {};
  for (const d of top50) {
    const state = sectxtStateByDomain.get(d.domain) ?? 'ABSENT';
    sectxtStates[state] = (sectxtStates[state] ?? 0) + 1;
  }

  // Annotate each top50 entry with sectxt state and DMARC policy for use in markdown
  for (const d of top50) {
    d.sectxtState   = sectxtStateByDomain.get(d.domain) ?? 'ABSENT';
    d.dmarcPolicy   = d.signals.dmarc ? (dmarcMap.get(d.domain)?.dmarc_policy ?? 'none') : null;
  }

  // --- Signal combination frequency ---
  const comboCounts = new Map();
  for (const d of top50) {
    const combo = SIGNAL_KEYS.filter(k => d.signals[k]).map(k => SIGNAL_LABELS[k]).join(' + ');
    comboCounts.set(combo, (comboCounts.get(combo) ?? 0) + 1);
  }
  const topCombos = [...comboCounts.entries()].sort((a,b) => b[1]-a[1]);

  // --- Firm-type ---
  const typeGroups = {};
  for (const d of top50) {
    const t = classifyFirm(d.name);
    if (!typeGroups[t]) typeGroups[t] = [];
    typeGroups[t].push(d.name);
  }

  // --- Outlier sets ---
  const maxCount      = top50[0]?.positiveCount ?? 0;
  const maxFirms      = top50.filter(d => d.positiveCount === maxCount);
  const strongEmail   = top50.filter(d => d.signals.spf && d.signals.dkim && d.signals.dmarc && d.dmarcPolicy === 'reject');
  const strongWeb     = top50.filter(d => d.signals.sechdr && d.signals.sectxt);
  const strongTransparency = top50.filter(d => d.signals.sectxt);

  // Bottom 50 absence counts (from IF001_LOWEST_SIGNAL_ADOPTION_GROUP.md)
  const bottom50Absence = { spf:36, dkim:50, dmarc:47, mtasts:50, tlsrpt:50, dnssec:50, caa:50, sectxt:50, sechdr:46 };

  // Write JSON
  fs.writeFileSync(
    path.join(__dirname, 'highest-adoption-raw.json'),
    JSON.stringify({ top50, dist, top50Presence, dmarcPolicyCounts, sectxtStates, topCombos: Object.fromEntries(topCombos), typeGroups, maxCount }, null, 2)
  );
  console.log('Written: highest-adoption-raw.json');

  // Write markdown
  const md = buildMarkdown({ top50, dist, top50Presence, dmarcPolicyCounts, sectxtStates, topCombos, typeGroups, maxCount, strongEmail, strongWeb, strongTransparency, maxFirms, bottom50Absence, totalDomains: domains.length });
  fs.writeFileSync(path.join(__dirname, '../../../IF001_HIGHEST_SIGNAL_ADOPTION_GROUP.md'), md);
  console.log('Written: IF001_HIGHEST_SIGNAL_ADOPTION_GROUP.md');
}

function buildMarkdown({ top50, dist, top50Presence, dmarcPolicyCounts, sectxtStates, topCombos, typeGroups, maxCount, strongEmail, strongWeb, strongTransparency, maxFirms, bottom50Absence, totalDomains }) {
  const lines = [];

  // Header
  lines.push('# IF-001 — Highest Signal Adoption Group');
  lines.push('');
  lines.push('**Cohort:** IF-001 — FCA Investment Firms (Full Cohort, 1,893 domains)');
  lines.push('**Collection date:** 2026-06-17');
  lines.push('**Report produced:** 2026-06-18');
  lines.push('**Status:** Observable evidence only. No scores, risk ratings, or assessments.');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Signal definitions
  lines.push('## Signal Definitions');
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
  lines.push('**Positive Signal Count:** sum of positive signals. Maximum observable in IF-001: **8** — TLS-RPT is absent from all 1,893 domains; no firm can achieve 9.');
  lines.push('');
  lines.push(`**Selection:** Ranked descending by Positive Signal Count. Tiebreaker within equal counts: alphabetical by domain. Top 50 spans counts ${top50[0]?.positiveCount} down to ${top50[49]?.positiveCount}.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Firm table
  lines.push('## Top 50 Firms by Positive Signal Count');
  lines.push('');
  lines.push('| # | Firm Name | Domain | Count | Signals Present | Signals Absent |');
  lines.push('|---|---|---|---|---|---|');
  for (let i = 0; i < top50.length; i++) {
    const d       = top50[i];
    const present = SIGNAL_KEYS.filter(k => d.signals[k]).map(k => SIGNAL_LABELS[k]).join(', ') || '—';
    const absent  = SIGNAL_KEYS.filter(k => !d.signals[k]).map(k => SIGNAL_LABELS[k]).join(', ') || '—';
    lines.push(`| ${i+1} | ${d.name.replace(/\|/g,'\\|')} | ${d.domain} | ${d.positiveCount} | ${present} | ${absent} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Distribution
  lines.push('## Distribution Analysis');
  lines.push('');
  lines.push('### Top 50 — signal count distribution');
  lines.push('');
  lines.push('| Signal count | Firms in Top 50 |');
  lines.push('|---|---|');
  for (let c = 9; c >= 4; c--) {
    lines.push(`| ${c} | ${top50.filter(d => d.positiveCount === c).length} |`);
  }
  lines.push(`| 3 or fewer | ${top50.filter(d => d.positiveCount <= 3).length} |`);
  lines.push('');
  lines.push('### Full cohort reference (1,893 domains)');
  lines.push('');
  lines.push('| Signal count | Domains | % of cohort |');
  lines.push('|---|---|---|');
  for (const c of Object.keys(dist).map(Number).sort((a,b) => b-a)) {
    const n = dist[String(c)];
    lines.push(`| ${c} | ${n} | ${pct(n, totalDomains)} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Top Cohort Characteristics
  lines.push('## Top Cohort Characteristics');
  lines.push('');
  lines.push('Observation only. No inferences about cause or intent.');
  lines.push('');

  const nearUniversal = SIGNAL_KEYS.filter(k => top50Presence[k] >= 48);
  const common        = SIGNAL_KEYS.filter(k => top50Presence[k] >= 35 && top50Presence[k] < 48);
  const lessCom       = SIGNAL_KEYS.filter(k => top50Presence[k] > 0 && top50Presence[k] < 35);
  const absent        = SIGNAL_KEYS.filter(k => top50Presence[k] === 0);

  lines.push('### Signal prevalence tiers within Top 50');
  lines.push('');
  if (nearUniversal.length) lines.push(`**Near-universal (≥48/50):** ${nearUniversal.map(k => `${SIGNAL_LABELS[k]} (${top50Presence[k]}/50)`).join(', ')}`);
  if (common.length)        lines.push(`**Common (35–47/50):** ${common.map(k => `${SIGNAL_LABELS[k]} (${top50Presence[k]}/50)`).join(', ')}`);
  if (lessCom.length)       lines.push(`**Less common (1–34/50):** ${lessCom.map(k => `${SIGNAL_LABELS[k]} (${top50Presence[k]}/50)`).join(', ')}`);
  if (absent.length)        lines.push(`**Absent from all 50 (0/50):** ${absent.map(k => SIGNAL_LABELS[k]).join(', ')}`);
  lines.push('');

  lines.push('### Most common signal combinations (Top 50)');
  lines.push('');
  lines.push('| Signals present | Firms |');
  lines.push('|---|---|');
  for (const [combo, count] of topCombos.slice(0, 10)) {
    lines.push(`| ${combo} | ${count} |`);
  }
  lines.push('');

  lines.push('### DMARC policy distribution within Top 50');
  lines.push('');
  lines.push('| Policy | Count | % of Top 50 |');
  lines.push('|---|---|---|');
  lines.push(`| reject | ${dmarcPolicyCounts.reject} | ${pct(dmarcPolicyCounts.reject, 50)} |`);
  lines.push(`| quarantine | ${dmarcPolicyCounts.quarantine} | ${pct(dmarcPolicyCounts.quarantine, 50)} |`);
  lines.push(`| none | ${dmarcPolicyCounts.none} | ${pct(dmarcPolicyCounts.none, 50)} |`);
  lines.push(`| DMARC absent | ${dmarcPolicyCounts.absent} | ${pct(dmarcPolicyCounts.absent, 50)} |`);
  lines.push('');

  lines.push('### Security.txt file state within Top 50');
  lines.push('');
  lines.push('| State | Count |');
  lines.push('|---|---|');
  for (const [state, count] of Object.entries(sectxtStates).sort((a,b) => b[1]-a[1])) {
    lines.push(`| ${state} | ${count} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Signal Concentration
  lines.push('## Signal Concentration Analysis — Top 50');
  lines.push('');
  lines.push('| Signal | Adoption in Top 50 | Adoption % | Full cohort adoption |');
  lines.push('|---|---|---|---|');
  const cohortAdoption = {
    spf: '61.7%', dkim: '50.7%', dmarc: '73.6%', mtasts: '4.3%',
    tlsrpt: '0.0%', dnssec: '6.2%', caa: '4.7%', sectxt: '11.6%', sechdr: '64.2%',
  };
  for (const k of SIGNAL_KEYS) {
    lines.push(`| ${SIGNAL_LABELS[k]} | ${top50Presence[k]}/50 | ${pct(top50Presence[k], 50)} | ${cohortAdoption[k]} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Firm-Type Analysis
  lines.push('## Firm-Type Analysis');
  lines.push('');
  lines.push('Classification by firm name keyword only. No external entity data used. First matching keyword determines category.');
  lines.push('');
  lines.push('| Firm type | Count | Firms |');
  lines.push('|---|---|---|');
  for (const [type, firmList] of Object.entries(typeGroups).sort((a,b) => b[1].length-a[1].length)) {
    lines.push(`| ${type} | ${firmList.length} | ${firmList.map(n => n.replace(/\|/g,'\\|')).join('; ')} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Top vs Bottom
  lines.push('## Top vs Bottom Comparison');
  lines.push('');
  lines.push('**Top 50:** this report. **Bottom 50:** `IF001_LOWEST_SIGNAL_ADOPTION_GROUP.md`.');
  lines.push('');
  lines.push('| Signal | Top 50 | Bottom 50 | Gap (pp) |');
  lines.push('|---|---|---|---|');
  const gaps = [];
  for (const k of SIGNAL_KEYS) {
    const topN = top50Presence[k];
    const botN = 50 - bottom50Absence[k];
    const gap  = ((topN/50)*100) - ((botN/50)*100);
    gaps.push({ k, topN, botN, gap });
    lines.push(`| ${SIGNAL_LABELS[k]} | ${topN}/50 (${pct(topN,50)}) | ${botN}/50 (${pct(botN,50)}) | +${gap.toFixed(1)}pp |`);
  }
  lines.push('');

  const sortedGaps = [...gaps].sort((a,b) => b.gap - a.gap);

  lines.push('### Largest separation gaps');
  lines.push('');
  for (const { k, topN, botN, gap } of sortedGaps.slice(0, 5)) {
    lines.push(`- **${SIGNAL_LABELS[k]}:** Top 50 ${topN}/50 (${pct(topN,50)}) vs Bottom 50 ${botN}/50 (${pct(botN,50)}) — **${gap.toFixed(1)}pp**`);
  }
  lines.push('');

  const uniqueToTop = gaps.filter(g => g.topN > 0 && g.botN === 0);
  const inBoth      = gaps.filter(g => g.topN > 0 && g.botN > 0);
  const inNeither   = gaps.filter(g => g.topN === 0 && g.botN === 0);

  if (uniqueToTop.length) {
    lines.push(`**Signals present in Top 50 but zero in Bottom 50:** ${uniqueToTop.map(g => SIGNAL_LABELS[g.k]).join(', ')}`);
    lines.push('');
  }
  if (inBoth.length) {
    lines.push(`**Signals present in both groups:** ${inBoth.map(g => `${SIGNAL_LABELS[g.k]} (Top: ${pct(g.topN,50)}, Bottom: ${pct(g.botN,50)})`).join('; ')}`);
    lines.push('');
  }
  if (inNeither.length) {
    lines.push(`**Signals absent from both groups:** ${inNeither.map(g => SIGNAL_LABELS[g.k]).join(', ')}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  // Outlier Review
  lines.push('## Outlier Review');
  lines.push('');

  lines.push(`### Firms with maximum observable signal count (${maxCount}/9)`);
  lines.push('');
  if (maxFirms.length > 0) {
    lines.push('| Firm | Domain | Signals present |');
    lines.push('|---|---|---|');
    for (const d of maxFirms) {
      const present = SIGNAL_KEYS.filter(k => d.signals[k]).map(k => SIGNAL_LABELS[k]).join(', ');
      lines.push(`| ${d.name.replace(/\|/g,'\\|')} | ${d.domain} | ${present} |`);
    }
  }
  lines.push('');

  lines.push('### Strongest email-control profile');
  lines.push('');
  lines.push('Definition: SPF present AND DKIM present AND DMARC present with `policy=reject`.');
  lines.push('');
  lines.push(`${strongEmail.length} firms in the Top 50:`);
  lines.push('');
  if (strongEmail.length > 0) {
    lines.push('| Firm | Domain |');
    lines.push('|---|---|');
    for (const d of strongEmail) lines.push(`| ${d.name.replace(/\|/g,'\\|')} | ${d.domain} |`);
  }
  lines.push('');

  lines.push('### Strongest web-control profile');
  lines.push('');
  lines.push('Definition: Security Headers present AND Security.txt present.');
  lines.push('');
  lines.push(`${strongWeb.length} firms in the Top 50:`);
  lines.push('');
  if (strongWeb.length > 0) {
    lines.push('| Firm | Domain |');
    lines.push('|---|---|');
    for (const d of strongWeb) lines.push(`| ${d.name.replace(/\|/g,'\\|')} | ${d.domain} |`);
  }
  lines.push('');

  lines.push('### Strongest transparency profile');
  lines.push('');
  lines.push('Definition: Security.txt present.');
  lines.push('');
  lines.push(`${strongTransparency.length} firms in the Top 50 have a security.txt file:`);
  lines.push('');
  if (strongTransparency.length > 0) {
    lines.push('| Firm | Domain | Security.txt state |');
    lines.push('|---|---|---|');
    for (const d of strongTransparency) {
      lines.push(`| ${d.name.replace(/\|/g,'\\|')} | ${d.domain} | ${d.sectxtState} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Benchmark Interpretation
  lines.push('## Benchmark Interpretation');
  lines.push('');

  const topSpf  = top50Presence.spf,   topDkim = top50Presence.dkim;
  const topDmarc= top50Presence.dmarc, topSechdr = top50Presence.sechdr;
  const topDnssec = top50Presence.dnssec, topCaa = top50Presence.caa;
  const topMtasts = top50Presence.mtasts, topSectxt = top50Presence.sectxt;

  lines.push('### 1. What observable characteristics define the highest-adoption firms?');
  lines.push('');
  lines.push(`The Top 50 firms share near-universal email authentication and security header presence, combined with significantly elevated adoption of the infrastructure-layer signals that are rare in the full cohort.`);
  lines.push('');
  lines.push(`SPF is present in ${topSpf}/50 (${pct(topSpf,50)}) of Top 50 firms vs 61.7% cohort-wide. DKIM is ${topDkim}/50 (${pct(topDkim,50)}) vs 50.7%. DMARC is ${topDmarc}/50 (${pct(topDmarc,50)}) vs 73.6%. Security Headers is ${topSechdr}/50 (${pct(topSechdr,50)}) vs 64.2% cohort-wide.`);
  lines.push('');
  lines.push(`The infrastructure signals are the clearest differentiators: DNSSEC ${topDnssec}/50 (${pct(topDnssec,50)}) vs 6.2% cohort-wide; CAA ${topCaa}/50 (${pct(topCaa,50)}) vs 4.7%; MTA-STS ${topMtasts}/50 (${pct(topMtasts,50)}) vs 4.3%. These three signals, deployed by fewer than 1 in 17 firms cohort-wide, are heavily concentrated in the Top 50.`);
  lines.push('');

  lines.push('### 2. Which signals most strongly separate the Top 50 and Bottom 50?');
  lines.push('');
  for (const { k, topN, botN, gap } of sortedGaps.slice(0, 5)) {
    lines.push(`- **${SIGNAL_LABELS[k]}:** ${gap.toFixed(1)}pp gap — Top 50 ${topN}/50 (${pct(topN,50)}) vs Bottom 50 ${botN}/50 (${pct(botN,50)})`);
  }
  lines.push('');
  lines.push(`TLS-RPT is zero in both groups. It is the only signal that provides no separation between the two extremes.`);
  lines.push('');

  lines.push('### 3. Are the highest-adoption firms concentrated in specific firm types?');
  lines.push('');
  const sortedTypes = Object.entries(typeGroups).sort((a,b) => b[1].length-a[1].length);
  lines.push(`Based on firm-name keyword classification, the Top 50 contains:`);
  lines.push('');
  for (const [type, list] of sortedTypes) {
    lines.push(`- **${type}:** ${list.length} firm${list.length===1?'':'s'}`);
  }
  lines.push('');
  lines.push(`This classification uses firm name keywords only and does not draw on external entity data. The observed type distribution reflects name-based patterns in the Top 50; no causal relationship between firm type and signal adoption is asserted.`);
  lines.push('');

  lines.push('### 4. Which signals appear most associated with broad signal adoption?');
  lines.push('');
  lines.push(`SPF, DKIM, DMARC, and Security Headers are the four signals present in nearly all Top 50 firms. A firm with all four is observable in the upper signal-count tier. These four signals appear to form a baseline that is necessary but not sufficient for Top 50 membership — many mid-cohort firms also have these four.`);
  lines.push('');
  lines.push(`DNSSEC, CAA, and MTA-STS are the signals that most specifically distinguish Top 50 membership. They are rare cohort-wide but concentrated in the top group. Firms with DNSSEC or CAA present are observable almost exclusively in the upper signal-count tiers. This suggests these signals co-occur with other signals rather than appearing in isolation — they are deployed alongside the email and header baseline, not instead of it.`);
  lines.push('');

  lines.push('### 5. What does the comparison reveal about variation within the FCA investment firm sector?');
  lines.push('');
  lines.push(`The top-to-bottom comparison reveals a sector with extreme observable spread. The Bottom 50 has zero adoption of DKIM, MTA-STS, DNSSEC, CAA, Security.txt, and TLS-RPT. The Top 50 has significant adoption of all signals except TLS-RPT.`);
  lines.push('');
  lines.push(`The maximum observable count in IF-001 is ${maxCount}/9 (limited to 8 maximum by universal TLS-RPT absence). The minimum is 0. The modal count for the full 1,893-domain cohort is 3. This distribution — from 0 to ${maxCount} with a mode of 3 — indicates that the sector does not cluster around a common infrastructure baseline. There is no dominant observable standard that most firms have converged on.`);
  lines.push('');
  lines.push(`The comparison also shows that the separation between top and bottom is not driven by any single signal but by a combination: firms in the Top 50 have broadly deployed across multiple signal categories simultaneously. The Bottom 50 firms are not distinguished by selective absence of one signal — they have near-zero presence across all nine.`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Data source: Soterius Signal Lab — IF-001 collection, 2026-06-17*');
  lines.push('*Analysis script: `backend/signal-lab/if001-full/query-highest-adoption.js`*');
  lines.push('*Observable evidence only. No scores, grades, risk ratings, maturity assessments, or recommendations.*');

  return lines.join('\n');
}

main().catch(err => { console.error(err.stack); process.exit(1); });
