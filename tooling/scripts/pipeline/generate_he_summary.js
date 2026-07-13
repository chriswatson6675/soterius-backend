'use strict';
/**
 * HE-001 First Findings Summary
 *
 * Queries the scans table for all OfS prospects (pipeline_status = scan_complete),
 * computes benchmark statistics, and prints a formatted report including
 * a comparison against FCA Cohort 001.
 *
 * Usage:
 *   node scripts/pipeline/generate_he_summary.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { getRiskBand } = require('../../../infra/utils/trust-score-bands');

const client = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── Data fetching ─────────────────────────────────────────────────────────────

async function getScansForRegulator(regulator) {
  // Fetch all scan_complete prospects for the regulator
  const PAGE = 1000;
  let prospects = []; let from = 0;
  while (true) {
    const { data, error } = await client
      .from('prospects')
      .select('id, firm_name, regulator_id, website')
      .eq('regulator', regulator)
      .eq('pipeline_status', 'scan_complete')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`getScansForRegulator prospects(${regulator}): ${error.message}`);
    if (!data || !data.length) break;
    prospects = prospects.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  if (!prospects.length) return [];

  const prospectIds = prospects.map(p => p.id);
  const prospectMap = Object.fromEntries(prospects.map(p => [p.id, p]));

  // Fetch all scans for these prospects — chunk prospectIds to avoid URL length limits
  let scans = [];
  const CHUNK = 200;
  for (let c = 0; c < prospectIds.length; c += CHUNK) {
    const chunk = prospectIds.slice(c, c + CHUNK);
    let chunkFrom = 0;
    while (true) {
      const { data, error } = await client
        .from('scans')
        .select('id, prospect_id, overall_score, risk_band, score_object, scanned_at')
        .in('prospect_id', chunk)
        .order('scanned_at', { ascending: false })
        .range(chunkFrom, chunkFrom + PAGE - 1);
      if (error) throw new Error(`getScansForRegulator scans(${regulator}): ${error.message}`);
      if (!data || !data.length) break;
      scans = scans.concat(data);
      if (data.length < PAGE) break;
      chunkFrom += PAGE;
    }
  }

  // Deduplicate: keep only the most recent scan per prospect
  const seen = new Set();
  const latest = scans.filter(s => {
    if (seen.has(s.prospect_id)) return false;
    seen.add(s.prospect_id);
    return true;
  });

  // Attach prospect data
  return latest.map(s => ({
    ...s,
    prospect: prospectMap[s.prospect_id] || null,
  }));
}

// ── Statistics ────────────────────────────────────────────────────────────────

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Delegates to the one canonical threshold table (infra/utils/trust-score-
// bands.js, ADR-SYS-011 §"Canonical Presentation Model") instead of a local
// duplicate ladder — same 90/75/60/40 cutoffs, no report output changes.
const riskBand = getRiskBand;

function computeStats(rows) {
  const scores = rows
    .map(r => typeof r.overall_score === 'number' ? r.overall_score : null)
    .filter(s => s !== null);

  const sorted = [...scores].sort((a, b) => a - b);

  const bands = { 'Excellent': 0, 'Good': 0, 'Moderate Risk': 0, 'High Risk': 0, 'Critical Risk': 0 };
  scores.forEach(s => { bands[riskBand(s)] = (bands[riskBand(s)] || 0) + 1; });

  const catMeans = {};
  const catKeys  = ['ssl', 'email', 'headers', 'vulnComp', 'gdpr'];
  catKeys.forEach(key => {
    const vals = rows
      .map(r => r.score_object?.categoryBreakdown?.[key]?.percentage)
      .filter(v => typeof v === 'number');
    catMeans[key] = vals.length ? Math.round(mean(vals) * 10) / 10 : null;
  });

  return {
    n:       scores.length,
    mean:    Math.round(mean(scores) * 10) / 10,
    median:  Math.round(percentile(sorted, 50) * 10) / 10,
    q1:      Math.round(percentile(sorted, 25) * 10) / 10,
    q3:      Math.round(percentile(sorted, 75) * 10) / 10,
    min:     sorted[0]                ?? null,
    max:     sorted[sorted.length -1] ?? null,
    bands,
    catMeans,
    sorted,
    rows,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

const W = 60;
function rule()         { console.log('═'.repeat(W)); }
function line(l, r)     { const gap = W - 2 - l.length - String(r).length; console.log(` ${l}${' '.repeat(Math.max(1, gap))}${r}`); }
function section(title) { console.log('\n' + '─'.repeat(W)); console.log(` ${title}`); console.log('─'.repeat(W)); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n' + '═'.repeat(W));
  console.log(' HE-001 FIRST FINDINGS SUMMARY');
  console.log(' ' + new Date().toISOString().slice(0, 10));
  rule();

  // ── Fetch data
  console.log('\n Fetching HE scan data...');
  const heRows  = await getScansForRegulator('OfS');

  console.log(' Fetching FCA scan data...');
  const fcaRows = await getScansForRegulator('FCA');

  if (!heRows.length) {
    console.log('\n No scan_complete OfS records found. Run validate.js and scan.js first.\n');
    process.exit(0);
  }

  const he  = computeStats(heRows);
  const fca = computeStats(fcaRows);

  // ── Overview
  section('OVERVIEW');
  line('Institutions scanned', he.n);
  line('Mean score', `${he.mean}%`);
  line('Median score', `${he.median}%`);
  line('Q1 (25th percentile)', `${he.q1}%`);
  line('Q3 (75th percentile)', `${he.q3}%`);
  line('Min score', `${he.min}%`);
  line('Max score', `${he.max}%`);

  // ── Risk band distribution
  section('RISK BAND DISTRIBUTION');
  const bandOrder = ['Excellent', 'Good', 'Moderate Risk', 'High Risk', 'Critical Risk'];
  bandOrder.forEach(band => {
    const n   = he.bands[band] || 0;
    const pct = he.n > 0 ? Math.round(n / he.n * 100) : 0;
    line(band, `${n} (${pct}%)`);
  });

  const criticalPct = he.n > 0
    ? Math.round((he.bands['Critical Risk'] || 0) / he.n * 100)
    : 0;
  const highPct = he.n > 0
    ? Math.round((he.bands['High Risk'] || 0) / he.n * 100)
    : 0;

  console.log('');
  line('Critical Risk percentage', `${criticalPct}%`);
  line('High Risk percentage', `${highPct}%`);
  line('At risk (High + Critical)', `${criticalPct + highPct}%`);

  // ── Category breakdown
  section('CATEGORY BREAKDOWN (mean %)');
  const catLabels = {
    ssl:      'SSL/TLS Encryption     (max 40 pts)',
    email:    'Email Security         (max 56 pts)',
    headers:  'Security Headers       (max 50 pts)',
    vulnComp: 'Vulnerable Components  (max 48 pts)',
    gdpr:     'GDPR / Cookie          (max 12 pts)',
  };
  Object.entries(catLabels).forEach(([key, label]) => {
    const val = he.catMeans[key];
    line(label, val !== null ? `${val}%` : 'N/A');
  });

  // ── Top 10
  section('TOP 10 INSTITUTIONS');
  const top10 = [...heRows]
    .filter(r => typeof r.overall_score === 'number')
    .sort((a, b) => b.overall_score - a.overall_score)
    .slice(0, 10);

  top10.forEach((r, i) => {
    const name = r.prospect?.firm_name || r.prospect?.website || 'Unknown';
    const truncated = name.length > 42 ? name.slice(0, 39) + '...' : name;
    line(`${String(i + 1).padStart(2)}. ${truncated}`, `${r.overall_score}%`);
  });

  // ── Bottom 10
  section('BOTTOM 10 INSTITUTIONS');
  const bottom10 = [...heRows]
    .filter(r => typeof r.overall_score === 'number')
    .sort((a, b) => a.overall_score - b.overall_score)
    .slice(0, 10);

  bottom10.forEach((r, i) => {
    const name = r.prospect?.firm_name || r.prospect?.website || 'Unknown';
    const truncated = name.length > 42 ? name.slice(0, 39) + '...' : name;
    line(`${String(i + 1).padStart(2)}. ${truncated}`, `${r.overall_score}%`);
  });

  // ── FCA comparison
  section('FCA COMPARISON');
  if (!fca.n) {
    console.log(' No FCA scan data available.');
  } else {
    const delta = (heVal, fcaVal) => {
      const d = Math.round((heVal - fcaVal) * 10) / 10;
      return d >= 0 ? `+${d}pp` : `${d}pp`;
    };

    console.log(`\n ${'Metric'.padEnd(30)} ${'HE-001'.padEnd(10)} ${'FCA-001'.padEnd(10)} Delta`);
    console.log(` ${'─'.repeat(55)}`);

    const rows = [
      ['Institutions scanned',   he.n,                        fca.n,      null],
      ['Mean score',             `${he.mean}%`,               `${fca.mean}%`,   delta(he.mean, fca.mean)],
      ['Median score',           `${he.median}%`,             `${fca.median}%`, delta(he.median, fca.median)],
      ['Q1 (25th pct)',          `${he.q1}%`,                 `${fca.q1}%`,     delta(he.q1, fca.q1)],
      ['Q3 (75th pct)',          `${he.q3}%`,                 `${fca.q3}%`,     delta(he.q3, fca.q3)],
      ['Critical Risk',          `${criticalPct}%`,           `${fca.n > 0 ? Math.round((fca.bands['Critical Risk']||0)/fca.n*100) : '?'}%`, null],
      ['High Risk',              `${highPct}%`,               `${fca.n > 0 ? Math.round((fca.bands['High Risk']||0)/fca.n*100) : '?'}%`,     null],
      ['SSL/TLS mean',           `${he.catMeans.ssl}%`,       `${fca.catMeans.ssl}%`,      fca.catMeans.ssl ? delta(he.catMeans.ssl, fca.catMeans.ssl) : null],
      ['Email Security mean',    `${he.catMeans.email}%`,     `${fca.catMeans.email}%`,    fca.catMeans.email ? delta(he.catMeans.email, fca.catMeans.email) : null],
      ['Security Headers mean',  `${he.catMeans.headers}%`,   `${fca.catMeans.headers}%`,  fca.catMeans.headers ? delta(he.catMeans.headers, fca.catMeans.headers) : null],
      ['Vuln Components mean',   `${he.catMeans.vulnComp}%`,  `${fca.catMeans.vulnComp}%`, fca.catMeans.vulnComp ? delta(he.catMeans.vulnComp, fca.catMeans.vulnComp) : null],
      ['GDPR / Cookie mean',     `${he.catMeans.gdpr}%`,      `${fca.catMeans.gdpr}%`,     fca.catMeans.gdpr ? delta(he.catMeans.gdpr, fca.catMeans.gdpr) : null],
    ];

    rows.forEach(([label, heVal, fcaVal, d]) => {
      const l = ` ${label.padEnd(30)}`;
      const h = String(heVal).padEnd(10);
      const f = String(fcaVal).padEnd(10);
      const dStr = d || '';
      console.log(`${l} ${h} ${f} ${dStr}`);
    });
  }

  rule();
  console.log(` Generated: ${new Date().toISOString()}`);
  rule();
  console.log('');
}

run().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
