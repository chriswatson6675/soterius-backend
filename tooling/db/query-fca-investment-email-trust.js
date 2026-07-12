'use strict';

// FCA Investment/Wealth Management — Email Trust Top-Quintile Query
//
// Selects FCA-authorised investment/wealth managers on mainstream cloud email
// (M365 / Google Workspace), excluding global-bank subsidiaries, and ranks them
// by Category A (Email Trust) signal quality.
//
// ── Governance boundaries (read before extending) ───────────────────────────
//
// * Category A (Email Trust) ONLY. SPF/DKIM/DMARC quality models are frozen
//   v1.0 (SLG-044/045/046, SLG-052/054, SLG-060/063) and persisted in
//   signal_quality_{spf,dkim,dmarc}. Those are the only governed scores here.
//
// * NO Category B (Domain Trust). There is no signal_quality_dnssec/_caa table,
//   and SLG-067 records that CAA FAILED the Stage 3 trust gate: NOB-CAA-001 is
//   censored at the 512-byte DNS UDP limit (RFC 1035 §4.2.1), under-counting CAA
//   publishers by 11.6% and omitting 83.6% of domains with >=12 records.
//   Stages 4-7 are unopened. Do not rank on signal_facts_caa. When CAA `[C]`
//   remediation lands and a Domain Trust quality model is calibrated, add it at
//   the marker below (search: DOMAIN_TRUST_HOOK).
//
// * NO composite score. SLG-061 §44: "The score is independent of Trust
//   Framework weighting (a separate layer, out of scope of every calibration)."
//   We therefore never average SPF+DKIM+DMARC into one number. A firm qualifies
//   only if it is in the top quintile on ALL THREE independently. The three
//   percentiles are reported side by side.
//
// * Percentile population = the filtered peer cohort (see COHORT below), not the
//   national baseline. "Top 20%" means top 20% of comparable investment firms.
//
// Percentile uses the tie-fair midrank method, NOT the strict count-below method
// in query-he001-atlas.js. Quality scores are heavily tied at discrete bands
// (e.g. SPF primary 100/90/60/40/5/0); count-below would rank a large tied-at-max
// group below the 80th percentile, silently excluding the actual best performers.
//
// Output: console table + CSV to datasets/.
// Usage:  cd backend && node tooling/db/query-fca-investment-email-trust.js

require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

// ── Configuration ───────────────────────────────────────────────────────────

const REGISTRY = path.join(__dirname, '../../acquisition/runs/fca/registry.ndjson');
const OUT_CSV = path.join(__dirname, '../../../datasets/fca-investment-email-trust-top-quintile.csv');

// Governed run labels. One row per domain per run in each quality table.
const RUNS = { spf: 'NOB-001R', dkim: 'NOB-DKIM-001R', dmarc: 'NOB-DMARC-001' };

// FCA permission defining the investment/wealth management perimeter.
// "Managing investments" is the discretionary-management permission — the tight
// definition. Broader permissions ("Advising on investments", "Arranging deals
// in investments") sweep in IFAs, brokers and insurers, so they are not used.
const PERMISSION = 'Managing investments';

// Email provider detection reads the published SPF record. This is a PROXY for
// the MX host, not the MX host itself: a firm can publish an M365 include while
// routing inbound mail elsewhere (gateway, filtering relay). We do not collect
// MX, so this is the best available evidence. Treat as indicative.
const PROVIDERS = [
  { name: 'Microsoft 365', test: /include:spf\.protection\.outlook\.com/i },
  { name: 'Google Workspace', test: /include:_spf\.google\.com/i },
];

// Global-bank exclusions. Matched against the registrable label's tokens (split
// on hyphen), by exact token equality — substring matching would wrongly exclude
// e.g. "citizen*" for "citi". Every exclusion is logged for audit.
const BANK_KEYWORDS = new Set([
  'hsbc', 'barclays', 'natwest', 'lloyds', 'santander', 'rbs', 'halifax',
  'jpmorgan', 'jpmc', 'morganstanley', 'goldmansachs', 'goldman', 'gs',
  'citi', 'citibank', 'citigroup', 'ubs', 'creditsuisse', 'deutschebank',
  'deutsche', 'bnpparibas', 'bnp', 'socgen', 'societegenerale', 'rbc',
  'bankofamerica', 'bofa', 'merrilllynch', 'merrill', 'wellsfargo',
  'nomura', 'mizuho', 'mufg', 'standardchartered', 'schroders', 'natixis',
  'commerzbank', 'unicredit', 'intesa', 'rabobank', 'ing', 'abnamro',
]);

const TOP_PERCENTILE = 80; // "top 20th percentile" => percentile >= 80
const WANT = 20;
const CHUNK = 100;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  return createClient(url, key);
}

function normaliseDomain(website) {
  if (!website) return null;
  const d = String(website)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .replace(/^www\./, '');
  return d.includes('.') ? d : null;
}

// Registrable label, e.g. "foo-capital.co.uk" -> "foo-capital"
function sld(domain) {
  const parts = domain.split('.');
  const twoLevelTld = /^(co|org|ltd|plc|me|net|gov|ac|sch)$/.test(parts[parts.length - 2] || '');
  return parts[parts.length - (twoLevelTld ? 3 : 2)] || parts[0];
}

function bankKeywordHit(domain) {
  for (const token of sld(domain).split('-')) {
    if (BANK_KEYWORDS.has(token)) return token;
  }
  return null;
}

// Tie-fair midrank percentile: values tied at the maximum share a percentile
// that reflects the whole tied block, so a large tied-at-top group is not
// pushed below the gate. Returns 0-100.
function midrankPercentile(sortedAsc, value) {
  let below = 0;
  let equal = 0;
  for (const v of sortedAsc) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return ((below + 0.5 * equal) / sortedAsc.length) * 100;
}

const round1 = (n) => Math.round(n * 10) / 10;

async function fetchByDomain(sb, table, columns, domains, extraEq) {
  const rows = [];
  for (let i = 0; i < domains.length; i += CHUNK) {
    let q = sb.from(table).select(columns).in('domain', domains.slice(i, i + CHUNK));
    if (extraEq) q = q.eq(extraEq[0], extraEq[1]);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
  }
  return rows;
}

// ── Stage 1: cohort from the FCA registry ───────────────────────────────────

function loadCohort() {
  const firms = new Map(); // domain -> firm name
  const excluded = [];
  let considered = 0;
  let noWebsite = 0;

  for (const line of fs.readFileSync(REGISTRY, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    const permissions = rec['firm.permissions'] || {};
    if (!(PERMISSION in permissions)) continue;

    const firm = (rec.firm || [{}])[0];
    if (firm.Status !== 'Authorised') continue;
    considered++;

    const site = (rec['firm.address'] || []).map((a) => a['Website Address']).find((w) => w && w.trim());
    const domain = normaliseDomain(site);
    if (!domain) { noWebsite++; continue; }

    const hit = bankKeywordHit(domain);
    if (hit) {
      excluded.push({ name: firm['Organisation Name'], domain, keyword: hit });
      continue;
    }
    // First firm wins on duplicate domains (group entities sharing a website).
    if (!firms.has(domain)) firms.set(domain, firm['Organisation Name']);
  }

  return { firms, excluded, considered, noWebsite };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const sb = getClient();

  const { firms, excluded, considered, noWebsite } = loadCohort();
  console.log(`FCA firms with "${PERMISSION}" + Authorised : ${considered}`);
  console.log(`  dropped, no website on register            : ${noWebsite}`);
  console.log(`  dropped, global-bank keyword               : ${excluded.length}`);
  for (const e of excluded) console.log(`      - ${e.domain}  (matched "${e.keyword}")  ${e.name}`);
  console.log(`  unique candidate domains                   : ${firms.size}\n`);

  const domains = [...firms.keys()];

  // ── Stage 2: cloud email provider, from the latest SPF observation ────────
  const spfFacts = await fetchByDomain(sb, 'signal_facts_spf', 'domain,spf_record,collected_at', domains);
  const latestSpf = new Map();
  for (const r of spfFacts) {
    const prev = latestSpf.get(r.domain);
    if (!prev || new Date(r.collected_at) > new Date(prev.collected_at)) latestSpf.set(r.domain, r);
  }

  const providerOf = new Map();
  for (const [domain, row] of latestSpf) {
    const match = PROVIDERS.find((p) => row.spf_record && p.test.test(row.spf_record));
    if (match) providerOf.set(domain, match.name);
  }
  console.log(`On M365 / Google Workspace (via SPF record)  : ${providerOf.size} of ${domains.length}`);

  // ── Stage 3: governed Category A quality scores ───────────────────────────
  const cohort = [...providerOf.keys()];
  const [spfQ, dkimQ, dmarcQ] = await Promise.all([
    fetchByDomain(sb, 'signal_quality_spf', 'domain,final_score', cohort, ['run_label', RUNS.spf]),
    fetchByDomain(sb, 'signal_quality_dkim', 'domain,final_score', cohort, ['run_label', RUNS.dkim]),
    fetchByDomain(sb, 'signal_quality_dmarc', 'domain,final_score', cohort, ['run_label', RUNS.dmarc]),
  ]);

  const score = (rows) => new Map(rows.map((r) => [r.domain, Number(r.final_score)]));
  const S = { spf: score(spfQ), dkim: score(dkimQ), dmarc: score(dmarcQ) };

  // A domain must be scored on all three signals to be rankable. Unscored means
  // "Observation Incomplete" — no row is emitted by design; it is not a zero.
  const scored = cohort.filter((d) => S.spf.has(d) && S.dkim.has(d) && S.dmarc.has(d));
  console.log(`Scored on all three Category A signals       : ${scored.length}`);
  console.log(`  (unscored on >=1 signal, excluded)         : ${cohort.length - scored.length}\n`);

  // DOMAIN_TRUST_HOOK — when Category B is calibrated, join signal_quality_dnssec
  // / _caa here and extend the gate below. Do NOT use signal_facts_caa (SLG-067).

  // ── Stage 4: percentiles within the peer cohort ───────────────────────────
  const dists = {
    spf: scored.map((d) => S.spf.get(d)).sort((a, b) => a - b),
    dkim: scored.map((d) => S.dkim.get(d)).sort((a, b) => a - b),
    dmarc: scored.map((d) => S.dmarc.get(d)).sort((a, b) => a - b),
  };

  for (const sig of ['spf', 'dkim', 'dmarc']) {
    const v = dists[sig];
    const max = v[v.length - 1];
    const atMax = v.filter((x) => x === max).length;
    console.log(
      `${sig.toUpperCase().padEnd(5)} cohort: median ${v[Math.floor(v.length / 2)]
        .toString()
        .padStart(6)}   max ${String(max).padStart(6)}   tied at max ${atMax} (${round1((atMax / v.length) * 100)}%)`,
    );
  }
  console.log();

  // CEILING CHECK. A percentile cannot exceed the midrank of the maximum value.
  // Where >20% of the cohort ties at the maximum, NO firm can reach the 80th
  // percentile on that signal, and a "top quintile" gate is unsatisfiable by
  // construction. This is a property of the cohort, not a bug — surface it.
  const maxOf = (sig) => dists[sig][dists[sig].length - 1];
  const maxAttainable = {
    spf: round1(midrankPercentile(dists.spf, maxOf('spf'))),
    dkim: round1(midrankPercentile(dists.dkim, maxOf('dkim'))),
    dmarc: round1(midrankPercentile(dists.dmarc, maxOf('dmarc'))),
  };
  const blocked = Object.entries(maxAttainable).filter(([, p]) => p < TOP_PERCENTILE);

  if (blocked.length) {
    console.log(`CEILING EFFECT — the "${TOP_PERCENTILE}th percentile on all three" gate is unsatisfiable.`);
    for (const [sig, p] of Object.entries(maxAttainable)) {
      const flag = p < TOP_PERCENTILE ? `<-- max attainable is below ${TOP_PERCENTILE}` : '';
      console.log(`  ${sig.toUpperCase().padEnd(5)} best possible percentile = ${String(p).padStart(5)}  ${flag}`);
    }
    console.log(
      `  ${blocked.map(([s]) => s.toUpperCase()).join(' and ')} do not discriminate in this cohort:\n` +
        '  too many firms hold the maximum score. Selecting by attainment tier instead.\n',
    );
  }

  const ranked = scored.map((domain) => ({
    firm: firms.get(domain),
    domain,
    provider: providerOf.get(domain),
    spfScore: S.spf.get(domain),
    dkimScore: S.dkim.get(domain),
    dmarcScore: S.dmarc.get(domain),
    pctSpf: round1(midrankPercentile(dists.spf, S.spf.get(domain))),
    pctDkim: round1(midrankPercentile(dists.dkim, S.dkim.get(domain))),
    pctDmarc: round1(midrankPercentile(dists.dmarc, S.dmarc.get(domain))),
  }));

  // Tier 1 = at the cohort maximum on all three signals simultaneously. This is
  // the strongest defensible reading of "top" once the percentile gate collapses.
  const isTier1 = (r) =>
    r.spfScore === maxOf('spf') && r.dkimScore === maxOf('dkim') && r.dmarcScore === maxOf('dmarc');

  const tier1 = ranked.filter(isTier1).sort((a, b) => a.firm.localeCompare(b.firm));
  // Tier 2 = below maximum on at least one signal. Ordered by the only signal
  // that discriminates (DMARC), then DKIM, then SPF.
  const tier2 = ranked
    .filter((r) => !isTier1(r))
    .sort((a, b) => b.dmarcScore - a.dmarcScore || b.dkimScore - a.dkimScore || b.spfScore - a.spfScore);

  console.log(`Tier 1 — at cohort maximum on all three      : ${tier1.length}`);

  if (tier1.length < WANT) {
    console.log(
      `\n  NOTE: only ${tier1.length} firms hold the maximum on all three signals.\n` +
        `  Filling to ${WANT} with Tier 2 firms, which are strictly below maximum on at\n` +
        '  least one signal. Tier 2 firms do NOT sit in any top quintile — see the tier\n' +
        '  column before using this list as a "top 20" claim.',
    );
  }

  const final = [...tier1, ...tier2].slice(0, WANT).map((r) => ({ ...r, tier: isTier1(r) ? 1 : 2 }));

  // ── Stage 5: output ───────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(104)}`);
  console.table(
    final.map((r) => ({
      Tier: r.tier,
      'Firm Name': r.firm.length > 40 ? `${r.firm.slice(0, 37)}...` : r.firm,
      Domain: r.domain,
      Provider: r.provider === 'Microsoft 365' ? 'M365' : 'Google',
      'SPF %ile': r.pctSpf,
      'DKIM %ile': r.pctDkim,
      'DMARC %ile': r.pctDmarc,
    })),
  );

  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const header = [
    'tier', 'firm_name', 'domain', 'email_provider',
    'spf_quality_score', 'spf_percentile',
    'dkim_quality_score', 'dkim_percentile',
    'dmarc_quality_score', 'dmarc_percentile',
  ];
  const csv = [
    header.join(','),
    ...final.map((r) =>
      [r.tier, r.firm, r.domain, r.provider, r.spfScore, r.pctSpf, r.dkimScore, r.pctDkim, r.dmarcScore, r.pctDmarc]
        .map(esc)
        .join(','),
    ),
  ].join('\n');

  fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
  fs.writeFileSync(OUT_CSV, `${csv}\n`, 'utf-8');
  console.log(`\nCSV written: ${path.relative(process.cwd(), OUT_CSV)}`);
  console.log(
    `Percentiles are within the ${scored.length}-firm peer cohort (midrank), Category A only.\n` +
      'Domain Trust excluded: no quality model; CAA baseline failed its trust gate (SLG-067).',
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
