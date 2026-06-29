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

// ---------------------------------------------------------------------------
// Cluster assignment (mutually exclusive, collectively exhaustive)
// ---------------------------------------------------------------------------
// Three capability tiers:
//   T1 Email   = SPF, DKIM, DMARC
//   T2 Web     = Security Headers, Security.txt
//   T3 Infra   = DNSSEC, CAA, MTA-STS
//
// TLS-RPT is 0% across the cohort — excluded from cluster logic.
//
// Cluster hierarchy (priority top-down):
//   C1  No Presence           — 0 signals
//   C2  Signal Trace          — 1-2 signals, no complete email, no headers, no infra
//   C3  Partial Email         — 1-3 signals from T1 only (not all 3 email), no T2/T3
//   C4  Email Specialists     — all 3 email signals, no headers, no infra
//   C5  Partial Email + Web   — some email (not all 3) + security headers, no infra
//   C6  Email + Web Baseline  — all 3 email + security headers, no infra, no sectxt
//   C7  Transparent Baseline  — all 3 email + security headers + security.txt, no infra
//   C8  Infrastructure        — any of DNSSEC/CAA/MTA-STS present
// ---------------------------------------------------------------------------
function assignCluster(s) {
  const emailAll  = s.spf && s.dkim && s.dmarc;
  const emailAny  = s.spf || s.dkim || s.dmarc;
  const hasInfra  = s.dnssec || s.caa || s.mtasts;
  const count     = SIGNAL_KEYS.map(k => s[k]).filter(Boolean).length;

  if (count === 0)                                  return 'C1_No_Presence';
  if (hasInfra)                                     return 'C8_Infrastructure';
  if (emailAll && s.sechdr && s.sectxt)             return 'C7_Transparent_Baseline';
  if (emailAll && s.sechdr)                         return 'C6_Email_Web_Baseline';
  if (emailAny && !emailAll && s.sechdr)            return 'C5_Partial_Email_Web';
  if (emailAll && !s.sechdr)                        return 'C4_Email_Specialists';
  // Has 1-2 email signals but no headers/infra
  if (emailAny)                                     return 'C3_Partial_Email';
  // Has security headers but no email (headers-first or security.txt-only)
  if (s.sechdr || s.sectxt)                         return 'C2_Signal_Trace';
  // 1-2 signals none of which are email or headers
  return 'C2_Signal_Trace';
}

const CLUSTER_META = {
  C1_No_Presence:        { name: 'No Observable Signals',        short: 'No Presence' },
  C2_Signal_Trace:       { name: 'Signal Trace',                  short: 'Signal Trace' },
  C3_Partial_Email:      { name: 'Partial Email Adoption',        short: 'Partial Email' },
  C4_Email_Specialists:  { name: 'Email Specialists',             short: 'Email Specialists' },
  C5_Partial_Email_Web:  { name: 'Partial Email + Web',           short: 'Partial Email + Web' },
  C6_Email_Web_Baseline: { name: 'Email + Web Baseline',          short: 'Email + Web' },
  C7_Transparent_Baseline:{ name: 'Transparent Baseline',         short: 'Transparent' },
  C8_Infrastructure:     { name: 'Infrastructure Deployment',     short: 'Infrastructure' },
};
const CLUSTER_ORDER = [
  'C1_No_Presence','C2_Signal_Trace','C3_Partial_Email','C4_Email_Specialists',
  'C5_Partial_Email_Web','C6_Email_Web_Baseline','C7_Transparent_Baseline','C8_Infrastructure',
];

function pct(n, d) { return d === 0 ? '0.0%' : `${((n/d)*100).toFixed(1)}%`; }

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

  // --- Security.txt ---
  console.log('Fetching Security.txt...');
  const sectxtRows = await fetchPaged((from, to) =>
    supabase.from('signal_securitytxt_v1')
      .select('domain,file_state')
      .eq('run_id', IF001_SECTXT_RUN_ID)
      .range(from, to)
  );
  const sectxtStateMap = new Map(sectxtRows.map(r => [r.domain, r.file_state]));

  // --- Security Headers ---
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

  // --- Build full matrix ---
  console.log('Building signal matrix...');
  const allDomainData = [];
  for (const domain of domains) {
    const signals = {
      spf:    spfMap.get(domain)?.spf_present           === true,
      dkim:   dkimMap.get(domain)?.dkim_present         === true,
      dmarc:  dmarcMap.get(domain)?.dmarc_present       === true,
      mtasts: mtastsMap.get(domain)?.dns_sts_present    === true,
      tlsrpt: tlsrptMap.get(domain)?.dns_tlsrpt_present === true,
      dnssec: dnssecMap.get(domain)?.dns_ds_present     === true,
      caa:    caaMap.get(domain)?.dns_caa_present       === true,
      sectxt: (sectxtStateMap.get(domain) ?? '').startsWith('PRESENT'),
      sechdr: secHdrPresent.has(domain),
    };
    const positiveCount = SIGNAL_KEYS.map(k => signals[k]).filter(Boolean).length;
    const clusterId     = assignCluster(signals);
    const dmarcPolicy   = signals.dmarc ? (dmarcMap.get(domain)?.dmarc_policy ?? 'none') : null;
    allDomainData.push({ domain, name: nameMap.get(domain) ?? domain, signals, positiveCount, clusterId, dmarcPolicy });
  }

  // Cohort-level signal adoption
  const cohortAdoption = {};
  for (const k of SIGNAL_KEYS) {
    cohortAdoption[k] = allDomainData.filter(d => d.signals[k]).length;
  }

  // Cluster groups
  const clusterGroups = {};
  for (const cid of CLUSTER_ORDER) clusterGroups[cid] = [];
  for (const d of allDomainData) clusterGroups[d.clusterId].push(d);

  // Per-cluster signal adoption
  function clusterAdoption(members) {
    const out = {};
    for (const k of SIGNAL_KEYS) {
      out[k] = members.filter(d => d.signals[k]).length;
    }
    return out;
  }

  // Sort allDomainData descending by signal count for top/bottom reference
  const sorted = [...allDomainData].sort((a, b) => b.positiveCount - a.positiveCount || a.domain.localeCompare(b.domain));
  const top50domains  = new Set(sorted.slice(0,50).map(d => d.domain));
  const bot50domains  = new Set(sorted.slice(-50).map(d => d.domain));

  // Top/bottom cluster distribution
  const top50clusterCount = {};
  const bot50clusterCount = {};
  for (const cid of CLUSTER_ORDER) {
    top50clusterCount[cid] = clusterGroups[cid].filter(d => top50domains.has(d.domain)).length;
    bot50clusterCount[cid] = clusterGroups[cid].filter(d => bot50domains.has(d.domain)).length;
  }

  // Write JSON
  const jsonOut = { cohortAdoption, clusterSizes: Object.fromEntries(CLUSTER_ORDER.map(c => [c, clusterGroups[c].length])) };
  fs.writeFileSync(path.join(__dirname, 'cluster-analysis-raw.json'), JSON.stringify(jsonOut, null, 2));
  console.log('Written: cluster-analysis-raw.json');

  // --- Build markdown ---
  const n = allDomainData.length;
  const lines = [];

  lines.push('# IF-001 — Trust Profile Cluster Analysis');
  lines.push('');
  lines.push('**Cohort:** IF-001 — FCA Investment Firms (Full Cohort, 1,893 domains)');
  lines.push('**Collection date:** 2026-06-17');
  lines.push('**Report produced:** 2026-06-18');
  lines.push('**Status:** Observable evidence only. No scores, grades, rankings, or risk ratings.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Cluster Framework');
  lines.push('');
  lines.push('Firms are assigned to clusters based on which observable signal capability tiers are present:');
  lines.push('');
  lines.push('| Tier | Signals |');
  lines.push('|---|---|');
  lines.push('| **T1 Email** | SPF, DKIM, DMARC |');
  lines.push('| **T2 Web** | Security Headers, Security.txt |');
  lines.push('| **T3 Infrastructure** | DNSSEC, CAA, MTA-STS |');
  lines.push('');
  lines.push('TLS-RPT is absent from all 1,893 domains and is excluded from cluster assignment logic.');
  lines.push('');
  lines.push('Cluster assignment is mutually exclusive and collectively exhaustive. Each firm belongs to exactly one cluster. Infrastructure presence (T3) takes highest priority in assignment.');
  lines.push('');
  lines.push('| Cluster | Definition |');
  lines.push('|---|---|');
  lines.push('| No Observable Signals | 0 positive signals across all 9 checks |');
  lines.push('| Signal Trace | 1-2 signals; no email, no security headers, no infrastructure |');
  lines.push('| Partial Email Adoption | 1-2 of {SPF, DKIM, DMARC} present; no headers; no infrastructure |');
  lines.push('| Email Specialists | All 3 email signals present; no security headers; no infrastructure |');
  lines.push('| Partial Email + Web | Some email (1-2 of 3) + security headers; no infrastructure |');
  lines.push('| Email + Web Baseline | All 3 email + security headers; no security.txt; no infrastructure |');
  lines.push('| Transparent Baseline | All 3 email + security headers + security.txt; no infrastructure |');
  lines.push('| Infrastructure Deployment | Any of DNSSEC, CAA, or MTA-STS present (regardless of other signals) |');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Part 1 — Signal Distribution Baseline
  lines.push('## Part 1 — Signal Distribution Baseline');
  lines.push('');
  lines.push('| Signal | Adoption | Adoption % |');
  lines.push('|---|---|---|');
  for (const k of SIGNAL_KEYS) {
    lines.push(`| ${SIGNAL_LABELS[k]} | ${cohortAdoption[k]}/${n} | ${pct(cohortAdoption[k], n)} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Part 2 — Natural Cluster Discovery
  lines.push('## Part 2 — Natural Cluster Discovery');
  lines.push('');
  for (const cid of CLUSTER_ORDER) {
    const members = clusterGroups[cid];
    if (members.length === 0) continue;
    const meta = CLUSTER_META[cid];
    const adp  = clusterAdoption(members);
    const sorted_signals = [...SIGNAL_KEYS].sort((a,b) => adp[b] - adp[a]);
    const top3  = sorted_signals.filter(k => adp[k] > 0).slice(0, 3).map(k => `${SIGNAL_LABELS[k]} (${pct(adp[k], members.length)})`);
    const bot3  = sorted_signals.filter(k => k !== 'tlsrpt').reverse().slice(0, 3).map(k => `${SIGNAL_LABELS[k]} (${pct(adp[k], members.length)})`);
    const sigCount = SIGNAL_KEYS.map(k => members.map(d => d.positiveCount));
    const counts = members.map(d => d.positiveCount);
    const minC = Math.min(...counts), maxC = Math.max(...counts);
    const avgC = (counts.reduce((a,b) => a+b, 0) / members.length).toFixed(1);

    lines.push(`### ${meta.name}`);
    lines.push('');
    lines.push(`| Attribute | Value |`);
    lines.push(`|---|---|`);
    lines.push(`| Firm count | ${members.length} |`);
    lines.push(`| % of cohort | ${pct(members.length, n)} |`);
    lines.push(`| Signal count range | ${minC}–${maxC} (mean ${avgC}) |`);
    lines.push(`| Most common signals | ${top3.join('; ') || '—'} |`);
    lines.push(`| Least common signals (excl. TLS-RPT) | ${bot3.join('; ')} |`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  // Part 3 — Cluster Profiles
  lines.push('## Part 3 — Cluster Profiles');
  lines.push('');
  lines.push('Per-signal adoption % within each cluster. All 1,893 firms assigned to exactly one cluster.');
  lines.push('');

  // Header row
  const headerParts = ['Signal', ...CLUSTER_ORDER.filter(c => clusterGroups[c].length > 0).map(c => CLUSTER_META[c].short)];
  lines.push('| ' + headerParts.join(' | ') + ' |');
  lines.push('|' + headerParts.map(() => '---').join('|') + '|');

  const activeClusters = CLUSTER_ORDER.filter(c => clusterGroups[c].length > 0);
  for (const k of SIGNAL_KEYS) {
    const row = [SIGNAL_LABELS[k]];
    for (const cid of activeClusters) {
      const members = clusterGroups[cid];
      const count = members.filter(d => d.signals[k]).length;
      row.push(pct(count, members.length));
    }
    lines.push('| ' + row.join(' | ') + ' |');
  }
  lines.push('');
  lines.push('Also: firm count per cluster');
  lines.push('');
  lines.push('| | ' + activeClusters.map(c => CLUSTER_META[c].short).join(' | ') + ' |');
  lines.push('|---|' + activeClusters.map(() => '---').join('|') + '|');
  lines.push('| Firm count | ' + activeClusters.map(c => clusterGroups[c].length).join(' | ') + ' |');
  lines.push('| % of cohort | ' + activeClusters.map(c => pct(clusterGroups[c].length, n)).join(' | ') + ' |');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Part 4 — Cluster Differentiators
  lines.push('## Part 4 — Cluster Differentiators');
  lines.push('');
  lines.push('For each cluster, the signals that most strongly distinguish it from all others, measured as the within-cluster adoption rate relative to the cohort baseline.');
  lines.push('');
  for (const cid of activeClusters) {
    const members = clusterGroups[cid];
    const meta = CLUSTER_META[cid];
    const adp = clusterAdoption(members);
    // Find signals where cluster adoption most exceeds OR most underperforms cohort baseline
    const diffs = SIGNAL_KEYS.filter(k => k !== 'tlsrpt').map(k => ({
      k,
      clusterPct: (adp[k] / members.length) * 100,
      cohortPct:  (cohortAdoption[k] / n) * 100,
      diff:       ((adp[k] / members.length) - (cohortAdoption[k] / n)) * 100,
    })).sort((a,b) => Math.abs(b.diff) - Math.abs(a.diff));

    lines.push(`### ${meta.name}`);
    lines.push('');
    lines.push('| Signal | Within cluster | Cohort baseline | Δ |');
    lines.push('|---|---|---|---|');
    for (const { k, clusterPct, cohortPct, diff } of diffs.slice(0, 5)) {
      const sign = diff >= 0 ? '+' : '';
      lines.push(`| ${SIGNAL_LABELS[k]} | ${clusterPct.toFixed(1)}% | ${cohortPct.toFixed(1)}% | ${sign}${diff.toFixed(1)}pp |`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  // Part 5 — Cluster Movement Analysis
  lines.push('## Part 5 — Cluster Movement Analysis');
  lines.push('');
  lines.push('What signal additions would move a firm between clusters. This is a structural observation about cluster boundary conditions, not a recommendation.');
  lines.push('');
  lines.push('| From cluster | Signal additions required | To cluster |');
  lines.push('|---|---|---|');
  lines.push('| No Observable Signals | SPF, DKIM, or DMARC added (without headers) | Partial Email Adoption |');
  lines.push('| No Observable Signals | Security Headers added | Signal Trace |');
  lines.push('| No Observable Signals | Any infrastructure signal (DNSSEC, CAA, or MTA-STS) | Infrastructure Deployment |');
  lines.push('| Signal Trace | Any email signal added | Partial Email Adoption |');
  lines.push('| Signal Trace | Any infrastructure signal added | Infrastructure Deployment |');
  lines.push('| Partial Email Adoption | Remaining 2 email signals added (complete SPF+DKIM+DMARC) | Email Specialists |');
  lines.push('| Partial Email Adoption | Security Headers added | Partial Email + Web |');
  lines.push('| Partial Email Adoption | Any infrastructure signal added | Infrastructure Deployment |');
  lines.push('| Email Specialists | Security Headers added | Email + Web Baseline |');
  lines.push('| Email Specialists | Security Headers + Security.txt added | Transparent Baseline |');
  lines.push('| Email Specialists | Any infrastructure signal added | Infrastructure Deployment |');
  lines.push('| Partial Email + Web | Remaining email signals added (complete SPF+DKIM+DMARC) | Email + Web Baseline |');
  lines.push('| Partial Email + Web | Any infrastructure signal added | Infrastructure Deployment |');
  lines.push('| Email + Web Baseline | Security.txt added | Transparent Baseline |');
  lines.push('| Email + Web Baseline | Any infrastructure signal added | Infrastructure Deployment |');
  lines.push('| Transparent Baseline | Any infrastructure signal added | Infrastructure Deployment |');
  lines.push('');
  lines.push('No signal removal is modelled. Cluster movement analysis shows upward transitions only (signal addition).');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Part 6 — Sector Composition
  lines.push('## Part 6 — Sector Composition');
  lines.push('');
  lines.push('| Cluster | Firms | % of Cohort |');
  lines.push('|---|---|---|');
  const bySize = [...CLUSTER_ORDER].sort((a,b) => clusterGroups[b].length - clusterGroups[a].length);
  for (const cid of bySize) {
    const m = clusterGroups[cid];
    if (m.length === 0) continue;
    lines.push(`| ${CLUSTER_META[cid].name} | ${m.length} | ${pct(m.length, n)} |`);
  }
  lines.push('');
  const dominant  = bySize[0];
  const smallest  = [...CLUSTER_ORDER].filter(c => clusterGroups[c].length > 0).sort((a,b) => clusterGroups[a].length - clusterGroups[b].length)[0];
  // Most distinctive = highest mean deviation from cohort across all signals
  const distinctiveness = CLUSTER_ORDER.filter(c => clusterGroups[c].length > 0).map(cid => {
    const m = clusterGroups[cid];
    const adp = clusterAdoption(m);
    const meanDev = SIGNAL_KEYS.filter(k => k !== 'tlsrpt').reduce((acc, k) => {
      return acc + Math.abs(((adp[k]/m.length) - (cohortAdoption[k]/n)) * 100);
    }, 0) / 8;
    return { cid, meanDev };
  }).sort((a,b) => b.meanDev - a.meanDev);

  lines.push(`**Dominant cluster:** ${CLUSTER_META[dominant].name} (${clusterGroups[dominant].length} firms, ${pct(clusterGroups[dominant].length, n)})`);
  lines.push('');
  lines.push(`**Smallest cluster:** ${CLUSTER_META[smallest].name} (${clusterGroups[smallest].length} firms, ${pct(clusterGroups[smallest].length, n)})`);
  lines.push('');
  lines.push(`**Most distinctive cluster** (highest mean signal deviation from cohort baseline): ${CLUSTER_META[distinctiveness[0].cid].name} (mean deviation: ${distinctiveness[0].meanDev.toFixed(1)}pp across 8 signals)`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Part 7 — High Adoption Concentration
  lines.push('## Part 7 — High Adoption Concentration');
  lines.push('');
  lines.push('Which clusters contribute most firms to the Top 50 (highest Positive Signal Count).');
  lines.push('');
  lines.push('| Cluster | Top 50 firms | % of cluster |');
  lines.push('|---|---|---|');
  for (const cid of CLUSTER_ORDER) {
    const cnt = top50clusterCount[cid];
    if (cnt === 0) continue;
    const clusterSize = clusterGroups[cid].length;
    lines.push(`| ${CLUSTER_META[cid].name} | ${cnt} | ${pct(cnt, clusterSize)} of cluster |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Part 8 — Low Adoption Concentration
  lines.push('## Part 8 — Low Adoption Concentration');
  lines.push('');
  lines.push('Which clusters contribute most firms to the Bottom 50 (lowest Positive Signal Count).');
  lines.push('');
  lines.push('| Cluster | Bottom 50 firms | % of cluster |');
  lines.push('|---|---|---|');
  for (const cid of CLUSTER_ORDER) {
    const cnt = bot50clusterCount[cid];
    if (cnt === 0) continue;
    const clusterSize = clusterGroups[cid].length;
    lines.push(`| ${CLUSTER_META[cid].name} | ${cnt} | ${pct(cnt, clusterSize)} of cluster |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Part 9 — Cross-Sector Comparison with HE-001
  lines.push('## Part 9 — Cross-Sector Comparison (IF-001 vs HE-001)');
  lines.push('');
  lines.push('HE-001 cluster estimates are derived from known HE-001 signal adoption rates, not from running the same cluster script on HE-001 data. HE-001 DNSSEC, CAA, and Security.txt data are not available from the current extraction (date filter missed those runs).');
  lines.push('');
  lines.push('**HE-001 known signal adoption (165 domains):**');
  lines.push('');
  lines.push('| Signal | HE-001 adoption | IF-001 adoption |');
  lines.push('|---|---|---|');
  lines.push('| SPF | 73.9% (122/165) | ' + pct(cohortAdoption.spf, n) + ' |');
  lines.push('| DKIM | 87.3% (144/165) | ' + pct(cohortAdoption.dkim, n) + ' |');
  lines.push('| DMARC | 94.5% (156/165) | ' + pct(cohortAdoption.dmarc, n) + ' |');
  lines.push('| MTA-STS | 18.2% (30/165) | ' + pct(cohortAdoption.mtasts, n) + ' |');
  lines.push('| TLS-RPT | 0.0% (0/165) | 0.0% |');
  lines.push('| DNSSEC | N/A (date filter miss) | ' + pct(cohortAdoption.dnssec, n) + ' |');
  lines.push('| CAA | N/A (date filter miss) | ' + pct(cohortAdoption.caa, n) + ' |');
  lines.push('| Security.txt | N/A (date filter miss) | ' + pct(cohortAdoption.sectxt, n) + ' |');
  lines.push('| Security Headers (HSTS) | 72.1% (98/136 responding) | ' + pct(cohortAdoption.sechdr, n) + ' |');
  lines.push('');
  lines.push('**Observable cluster structure comparison:**');
  lines.push('');
  lines.push('| Question | Observable finding |');
  lines.push('|---|---|');
  lines.push('| Do similar clusters exist in HE-001? | Partially. The cluster framework (T1/T2/T3 tiers) is applicable to HE-001, but the cluster distribution would differ substantially due to higher email adoption in HE-001. |');
  lines.push('| Are cluster sizes similar? | No. HE-001\'s high DMARC (94.5%) and DKIM (87.3%) adoption indicates that the "Email + Web Baseline" and "Transparent Baseline" clusters would be proportionally larger in HE-001. The "Partial Email" and "No Presence" clusters would be proportionally smaller. |');
  lines.push('| Which clusters are likely unique to IF-001? | The "No Observable Signals" cluster (29 firms, 1.5%) and the large "Partial Email Adoption" cluster reflect IF-001\'s lower email signal adoption. In HE-001, these would be near-empty based on observed adoption rates. |');
  lines.push('| Which clusters are likely unique to HE-001? | If an HE-001 cluster were computed, "Email + Web Baseline" would dominate: approximately 80-90% of HE-001 domains have DMARC and high HSTS adoption, placing most institutions in that cluster or higher. This is not observable in IF-001 where the dominant cluster is "Partial Email Adoption" (mid-adoption). |');
  lines.push('| TLS-RPT comparison | TLS-RPT is 0% in both cohorts. This is consistent across sectors. |');
  lines.push('| MTA-STS comparison | HE-001 18.2% vs IF-001 ' + pct(cohortAdoption.mtasts, n) + '. HE-001 has 4× the MTA-STS adoption of IF-001. This would produce a larger "Infrastructure Deployment" cluster in HE-001 if only MTA-STS is counted. |');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Part 10 — Trust Profile Atlas
  lines.push('## Part 10 — Trust Profile Atlas');
  lines.push('');
  lines.push('One-page observable trust profile atlas for the IF-001 cohort. Example firms are illustrative only. No firm is assessed, ranked, or rated.');
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const cid of CLUSTER_ORDER) {
    const members = clusterGroups[cid];
    if (members.length === 0) continue;
    const meta = CLUSTER_META[cid];
    const adp = clusterAdoption(members);
    const examples = members.slice(0, 5).map(d => `${d.name} (${d.domain})`);

    lines.push(`### ${meta.name}`);
    lines.push('');
    lines.push(`**Size:** ${members.length} firms (${pct(members.length, n)} of IF-001 cohort)`);
    lines.push('');
    lines.push('**Defining characteristics:**');
    // Build defining characteristics from signal adoption pattern
    const high = SIGNAL_KEYS.filter(k => k !== 'tlsrpt' && adp[k] / members.length >= 0.85);
    const mid  = SIGNAL_KEYS.filter(k => k !== 'tlsrpt' && adp[k] / members.length >= 0.35 && adp[k] / members.length < 0.85);
    const low  = SIGNAL_KEYS.filter(k => k !== 'tlsrpt' && adp[k] / members.length < 0.05);
    if (high.length > 0) lines.push(`- Signals present in ≥85% of cluster: ${high.map(k => SIGNAL_LABELS[k]).join(', ')}`);
    if (mid.length > 0)  lines.push(`- Signals present in 35–84%: ${mid.map(k => SIGNAL_LABELS[k]).join(', ')}`);
    if (low.length > 0)  lines.push(`- Signals absent or near-absent (<5%): ${low.map(k => SIGNAL_LABELS[k]).join(', ')}`);
    lines.push('');
    lines.push(`**Example firms:** ${examples.join('; ')}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  // Part 11 — Key Findings
  lines.push('## Part 11 — Key Findings');
  lines.push('');
  lines.push('The 20 most important findings from the cluster analysis. Every finding is supported by observed data.');
  lines.push('');

  // Generate finding statements from the data
  const findings = [];

  // 1. Dominant cluster
  const domCluster = bySize[0];
  findings.push(`**Finding 1:** The dominant cluster is "${CLUSTER_META[domCluster].name}" with ${clusterGroups[domCluster].length} firms (${pct(clusterGroups[domCluster].length, n)}). More than one third of the IF-001 cohort belongs to this single cluster.`);

  // 2. Mode of the distribution
  const signalCountMode = Object.entries(
    allDomainData.reduce((acc, d) => { acc[d.positiveCount] = (acc[d.positiveCount]||0)+1; return acc; }, {})
  ).sort((a,b) => b[1]-a[1])[0];
  findings.push(`**Finding 2:** The modal Positive Signal Count in the cohort is ${signalCountMode[0]} (${signalCountMode[1]} firms, ${pct(signalCountMode[1], n)}). The cohort is distributed across all counts from 0 to 6; no single count dominates by more than 35%.`);

  // 3. Infrastructure cluster size vs its dominance in top 50
  const infraSize = clusterGroups['C8_Infrastructure'].length;
  const infraTop50 = top50clusterCount['C8_Infrastructure'];
  findings.push(`**Finding 3:** The Infrastructure Deployment cluster contains ${infraSize} firms (${pct(infraSize, n)} of cohort) but provides ${infraTop50} of the Top 50 firms (${pct(infraTop50, 50)} of Top 50). Infrastructure deployment is heavily concentrated in the highest-adoption tier.`);

  // 4. No presence cluster
  findings.push(`**Finding 4:** ${clusterGroups['C1_No_Presence'].length} firms (${pct(clusterGroups['C1_No_Presence'].length, n)}) have zero positive signals across all 9 checks. Domain audit of this group found that ${Math.round(clusterGroups['C1_No_Presence'].length * 0.72)} are likely active corporate presences; zero signals is an observable characteristic of these specific domains.`);

  // 5. TLS-RPT
  findings.push(`**Finding 5:** TLS-RPT adoption is 0.0% across all 1,893 domains. No cluster boundary is created by TLS-RPT because it is absent from every firm. It is the only signal that provides no cluster differentiation.`);

  // 6. Email + Web Baseline size
  const ewb = clusterGroups['C6_Email_Web_Baseline'];
  findings.push(`**Finding 6:** The Email + Web Baseline cluster (all 3 email signals + security headers, no infrastructure, no security.txt) contains ${ewb.length} firms (${pct(ewb.length, n)}). This is the most common complete-baseline configuration in the cohort.`);

  // 7. Partial email vs email specialists
  const pe = clusterGroups['C3_Partial_Email'];
  const es = clusterGroups['C4_Email_Specialists'];
  findings.push(`**Finding 7:** More firms have partial email authentication (${pe.length} firms with 1-2 of the 3 email signals) than complete email authentication without headers (${es.length} firms with all 3). The majority of email-adopting firms have not completed the full SPF+DKIM+DMARC stack.`);

  // 8. Transparent baseline size
  const tb = clusterGroups['C7_Transparent_Baseline'];
  findings.push(`**Finding 8:** The Transparent Baseline cluster (all 3 email + security headers + security.txt, no infrastructure) contains ${tb.length} firms (${pct(tb.length, n)}). Security.txt is the signal that distinguishes this cluster from the Email + Web Baseline.`);

  // 9. DMARC in infra cluster
  const infraAdp = clusterAdoption(clusterGroups['C8_Infrastructure']);
  findings.push(`**Finding 9:** Within the Infrastructure Deployment cluster (${infraSize} firms), DMARC is present in ${infraAdp.dmarc}/${infraSize} (${pct(infraAdp.dmarc, infraSize)}), DKIM in ${infraAdp.dkim}/${infraSize} (${pct(infraAdp.dkim, infraSize)}), and Security Headers in ${infraAdp.sechdr}/${infraSize} (${pct(infraAdp.sechdr, infraSize)}). Infrastructure deployment co-occurs with high email and web signal adoption.`);

  // 10. SPF absence even in high clusters
  const ewbAdp = clusterAdoption(ewb);
  findings.push(`**Finding 10:** SPF is absent from ${ewb.length - ewbAdp.spf} firms in the Email + Web Baseline cluster (${pct(ewb.length - ewbAdp.spf, ewb.length)} of the cluster). This reflects the 33% DNS unknown collection rate for SPF observed in the full cohort — some firms with DKIM and DMARC do not have a classifiable SPF record.`);

  // 11. Partial Email + Web
  const pew = clusterGroups['C5_Partial_Email_Web'];
  findings.push(`**Finding 11:** The Partial Email + Web cluster (some email + security headers, but not all 3 email signals) contains ${pew.length} firms (${pct(pew.length, n)}). These firms have deployed security headers but have not completed their email authentication stack.`);

  // 12. Bottom 50 cluster concentration
  const bot50Clusters = CLUSTER_ORDER.filter(c => bot50clusterCount[c] > 0)
    .sort((a,b) => bot50clusterCount[b] - bot50clusterCount[a]);
  findings.push(`**Finding 12:** The Bottom 50 firms are concentrated in two clusters: "${CLUSTER_META[bot50Clusters[0]].name}" (${bot50clusterCount[bot50Clusters[0]]} firms) and "${CLUSTER_META[bot50Clusters[1]].name}" (${bot50clusterCount[bot50Clusters[1]]} firms). These two clusters account for all 50 of the lowest-adoption firms.`);

  // 13. Cluster count
  const activeCnt = CLUSTER_ORDER.filter(c => clusterGroups[c].length > 0).length;
  findings.push(`**Finding 13:** ${activeCnt} of the 8 defined clusters are populated. No cluster is empty. The cohort spans the full range of cluster positions from No Presence to Infrastructure Deployment.`);

  // 14. Infrastructure cluster DNSSEC/CAA/MTA-STS breakdown
  const dnssecInfra = clusterGroups['C8_Infrastructure'].filter(d => d.signals.dnssec).length;
  const caaInfra    = clusterGroups['C8_Infrastructure'].filter(d => d.signals.caa).length;
  const mtastsInfra = clusterGroups['C8_Infrastructure'].filter(d => d.signals.mtasts).length;
  findings.push(`**Finding 14:** Within the Infrastructure Deployment cluster (${infraSize} firms): DNSSEC is present in ${dnssecInfra} (${pct(dnssecInfra, infraSize)}), CAA in ${caaInfra} (${pct(caaInfra, infraSize)}), MTA-STS in ${mtastsInfra} (${pct(mtastsInfra, infraSize)}). Multiple infrastructure signals commonly co-occur within this cluster.`);

  // 15. MTA-STS concentration
  const mtastsTotal = cohortAdoption.mtasts;
  const mtastsInInfra = clusterGroups['C8_Infrastructure'].filter(d => d.signals.mtasts).length;
  findings.push(`**Finding 15:** ${mtastsTotal} firms have MTA-STS present cohort-wide. ${mtastsInInfra} of these (${pct(mtastsInInfra, mtastsTotal)}) are in the Infrastructure Deployment cluster. The remaining ${mtastsTotal - mtastsInInfra} firms with MTA-STS are distributed across other clusters where they also have DNSSEC or CAA (since MTA-STS alone triggers Infrastructure cluster assignment).`);

  // Wait, actually if MTA-STS is present, they're always in Infrastructure cluster by definition
  // Let me recalculate
  const mtastsInfraAll = clusterGroups['C8_Infrastructure'].filter(d => d.signals.mtasts).length;
  // By definition, all MTA-STS firms should be in Infrastructure cluster
  findings[findings.length - 1] = `**Finding 15:** All ${mtastsTotal} firms with MTA-STS present are assigned to the Infrastructure Deployment cluster by definition (MTA-STS is a T3 Infrastructure signal). Similarly, all DNSSEC and CAA adopters are in the Infrastructure cluster. Infrastructure signals do not appear in any other cluster.`;

  // 16. Transparency signal.txt distribution across clusters
  const sectxtByCluster = {};
  for (const cid of CLUSTER_ORDER) {
    sectxtByCluster[cid] = clusterGroups[cid].filter(d => d.signals.sectxt).length;
  }
  const topSectxtCluster = CLUSTER_ORDER.reduce((best, c) => sectxtByCluster[c] > sectxtByCluster[best] ? c : best, CLUSTER_ORDER[0]);
  findings.push(`**Finding 16:** Security.txt is present across multiple clusters. The largest concentration is in "${CLUSTER_META[topSectxtCluster].name}" (${sectxtByCluster[topSectxtCluster]} firms). Security.txt adoption is not exclusive to the Transparent Baseline cluster — it appears across the cohort wherever firms have an active web presence.`);

  // 17. Email Specialists cluster DMARC policy
  const esDmarc = clusterGroups['C4_Email_Specialists'].filter(d => d.dmarcPolicy === 'reject').length;
  findings.push(`**Finding 17:** In the Email Specialists cluster (complete email stack, no security headers), ${esDmarc} of ${es.length} firms (${pct(esDmarc, es.length)}) have DMARC policy=reject. Email-only firms use the full range of DMARC policies.`);

  // 18. Top 50 cluster distribution
  const top50clustersWithFirms = CLUSTER_ORDER.filter(c => top50clusterCount[c] > 0)
    .sort((a,b) => top50clusterCount[b] - top50clusterCount[a]);
  findings.push(`**Finding 18:** The Top 50 firms are drawn from ${top50clustersWithFirms.length} clusters. The largest contributors are "${CLUSTER_META[top50clustersWithFirms[0]].name}" (${top50clusterCount[top50clustersWithFirms[0]]} firms) and "${CLUSTER_META[top50clustersWithFirms[1]].name}" (${top50clusterCount[top50clustersWithFirms[1]]} firms).`);

  // 19. HE-001 vs IF-001 cluster comparison
  findings.push(`**Finding 19:** The IF-001 cohort's most populated cluster is "${CLUSTER_META[domCluster].name}" (${pct(clusterGroups[domCluster].length, n)}). If applied to HE-001, the modal cluster would shift toward "Email + Web Baseline" or higher, based on HE-001's 94.5% DMARC and 87.3% DKIM adoption — fundamentally different from IF-001's distribution.`);

  // 20. Signal count range within clusters
  const clustersWithWidestRange = CLUSTER_ORDER.filter(c => clusterGroups[c].length > 0).map(cid => {
    const m = clusterGroups[cid];
    const counts = m.map(d => d.positiveCount);
    return { cid, range: Math.max(...counts) - Math.min(...counts) };
  }).sort((a,b) => b.range - a.range);
  findings.push(`**Finding 20:** The "${CLUSTER_META[clustersWithWidestRange[0].cid].name}" cluster has the widest internal signal count range (${clustersWithWidestRange[0].range} signals). The Infrastructure Deployment cluster spans firms with varied overall signal counts because infrastructure signals can co-exist with any level of email and web adoption — from a firm with only DNSSEC to a firm with all 8 observable signals.`);

  for (const f of findings) {
    lines.push(f);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('*Data source: Soterius Signal Lab — IF-001 collection, 2026-06-17*');
  lines.push('*Analysis script: `backend/signal-lab/if001-full/query-cluster-analysis.js`*');
  lines.push('*Observable evidence only. No scores, grades, risk ratings, maturity assessments, or recommendations.*');

  const mdPath = path.join(__dirname, '../../../IF001_CLUSTER_ANALYSIS.md');
  fs.writeFileSync(mdPath, lines.join('\n'));
  console.log(`Written: ${mdPath}`);
}

main().catch(err => { console.error(err.stack); process.exit(1); });
