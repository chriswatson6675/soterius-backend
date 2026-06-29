'use strict';

// query-ownership-viability.js
//
// Ownership Signal Viability Test for SOT-CORPORATEIDENTITY-001.
// Queries signal_domainregistration_v1, classifies every record into
// COMPANY / PRIVACY_SERVICE / EMPTY / UNKNOWN, and prints a go/no-go verdict.
//
// Usage:
//   node backend/signal-lab/if001-full/query-ownership-viability.js

require('dotenv').config({ path: require('node:path').join(__dirname, '../../.env') });

const fs   = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

const TABLE      = 'signal_domainregistration_v1';
const JSON_OUT   = path.join(__dirname, 'ownership-viability-raw.json');
const CSV_OUT    = path.join(__dirname, '../../../ownership_signal_report.csv');

// ── Classification lists ───────────────────────────────────────────────────────

const COMPANY_INDICATORS = [
  ' limited', ' ltd', 'l.t.d',
  ' llp', 'l.l.p',
  ' plc', 'p.l.c',
  ' inc.', ' inc,', ' incorporated',
  ' llc', 'l.l.c',
  ' corporation', ' corp.',
  ' gmbh', ' s.a.', ' b.v.', ' n.v.', ' a.g.', ' s.e.', ' l.p.',
  ' partnership',
  'capital', 'management', 'securities', ' partners',
  'investments', 'asset management', ' fund', ' bank',
  'financial', 'holdings', 'advisors', 'advisory',
  'wealth', 'insurance', 'trust company',
];

const EMPTY_VALUES = new Set([
  '', 'n/a', 'na', 'none', 'null', '-', '.', 'unknown',
  'not available', 'not applicable', 'redacted', 'withheld',
  'data expunged', 'not disclosed', 'see registrar',
  'gdpr', 'upon request', 'n.a.',
]);

// ── Per-record classification ──────────────────────────────────────────────────

function classify(row) {
  // No RDAP response — no ownership data
  if (row.endpoint_state !== 'RDAP_RESPONSE_OBSERVED') return 'EMPTY';

  const ps = row.privacy_state;

  if (ps === 'PRIVACY_SERVICE') return 'PRIVACY_SERVICE';
  if (ps === 'REDACTED' || ps === 'ENTITY_ABSENT') return 'EMPTY';

  if (ps === 'REGISTRANT_DATA') {
    const ev  = row.evidence || {};
    const org  = String(ev.registrant_org_name  ?? '').trim();
    const name = String(ev.registrant_full_name ?? '').trim();
    const val  = org || name;

    if (!val || EMPTY_VALUES.has(val.toLowerCase())) return 'EMPTY';

    const lower = val.toLowerCase();
    if (COMPANY_INDICATORS.some(ind => lower.includes(ind))) return 'COMPANY';

    return 'UNKNOWN';
  }

  return 'UNKNOWN';
}

// ── Supabase helpers ───────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}

async function fetchAll(supabase) {
  const PAGE = 1000;
  let offset = 0;
  const all  = [];

  for (;;) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('domain, endpoint_state, privacy_state, evidence')
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
    if (!data || data.length === 0) break;

    all.push(...data);
    process.stdout.write(`  Fetched ${all.length.toLocaleString()} rows...\r`);

    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return all;
}

// ── Output helpers ─────────────────────────────────────────────────────────────

function topN(map, n = 50) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function writeReport(rows2, total, counts, signalRate, opaqueRate, verdict, topOrgs, topNames) {
  const lines = [
    ['OWNERSHIP SIGNAL VIABILITY REPORT'],
    ['source_table', TABLE],
    ['total_records', total],
    [],
    ['SECTION', 'CATEGORY DISTRIBUTION'],
    ['category', 'count', 'percentage'],
  ];
  for (const [cat, n] of rows2) {
    lines.push([cat, n, `${(n / total * 100).toFixed(1)}%`]);
  }
  lines.push(['TOTAL', total, '100.0%'], []);
  lines.push(['SECTION', 'KEY METRICS'], ['metric', 'value']);
  lines.push(['ownership_signal_rate', `${(signalRate * 100).toFixed(1)}%`]);
  lines.push(['opaque_rate',           `${(opaqueRate * 100).toFixed(1)}%`]);
  lines.push(['verdict',               verdict]);
  lines.push([]);
  lines.push(['SECTION', 'TOP 50 REGISTRANT ORG VALUES'], ['registrant_org_name', 'count']);
  for (const [v, c] of topOrgs) lines.push([v, c]);
  lines.push([]);
  lines.push(['SECTION', 'TOP 50 REGISTRANT NAME VALUES'], ['registrant_full_name', 'count']);
  for (const [v, c] of topNames) lines.push([v, c]);

  const csv = lines.map(r => r.join(',')).join('\n');
  fs.writeFileSync(CSV_OUT, csv, 'utf8');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const W = 60;
  const HR = '═'.repeat(W);

  console.log(`\n${HR}`);
  console.log('  OWNERSHIP SIGNAL VIABILITY TEST');
  console.log(`  Table: ${TABLE}`);
  console.log(`${HR}\n`);

  const supabase = getClient();

  // Pre-flight
  const { error: pingErr } = await supabase.from(TABLE).select('id').limit(1);
  if (pingErr) {
    if (pingErr.message?.includes('does not exist') || pingErr.code === '42P01') {
      console.error(`  ERROR: ${TABLE} table not found.`);
      console.error('  Run signals/domainregistration/run-if001.js first.\n');
    } else {
      console.error(`  ERROR: ${pingErr.message}\n`);
    }
    process.exit(1);
  }

  console.log('  Fetching records from Supabase...');
  const rows = await fetchAll(supabase);
  console.log(`\n  Loaded ${rows.length.toLocaleString()} records\n`);

  if (rows.length === 0) {
    console.error('  ERROR: No records in signal_domainregistration_v1.');
    console.error('  Run run-if001.js first.\n');
    process.exit(1);
  }

  // Classify
  const counts = { COMPANY: 0, PRIVACY_SERVICE: 0, EMPTY: 0, UNKNOWN: 0 };
  const orgMap  = {};
  const nameMap = {};

  for (const row of rows) {
    const cat = classify(row);
    counts[cat]++;

    const ev = row.evidence || {};
    const org  = String(ev.registrant_org_name  ?? '').trim();
    const name = String(ev.registrant_full_name ?? '').trim();

    if (org  && !EMPTY_VALUES.has(org.toLowerCase()))  orgMap[org]   = (orgMap[org]   || 0) + 1;
    if (name && !EMPTY_VALUES.has(name.toLowerCase())) nameMap[name] = (nameMap[name] || 0) + 1;
  }

  const total       = rows.length;
  const signalRate  = counts.COMPANY / total;
  const opaqueRate  = (counts.PRIVACY_SERVICE + counts.EMPTY) / total;
  const topOrgs     = topN(orgMap,  50);
  const topNames    = topN(nameMap, 50);

  const catRows = [
    ['COMPANY',         counts.COMPANY],
    ['PRIVACY_SERVICE', counts.PRIVACY_SERVICE],
    ['EMPTY',           counts.EMPTY],
    ['UNKNOWN',         counts.UNKNOWN],
  ];

  // ── Console output ─────────────────────────────────────────────────────────

  console.log('─'.repeat(W));
  console.log(`  ${'Category'.padEnd(22)} ${'Count'.padStart(7)}   ${'Pct'.padStart(6)}`);
  console.log(`  ${'─'.repeat(22)}  ${'─'.repeat(7)}   ${'─'.repeat(6)}`);
  for (const [cat, n] of catRows) {
    console.log(`  ${cat.padEnd(22)} ${String(n).padStart(7)}   ${(n / total * 100).toFixed(1).padStart(5)}%`);
  }
  console.log(`  ${'─'.repeat(22)}  ${'─'.repeat(7)}   ${'─'.repeat(6)}`);
  console.log(`  ${'TOTAL'.padEnd(22)} ${String(total).padStart(7)}   ${'100.0%'.padStart(6)}`);

  console.log(`\n  Ownership Signal Rate  ${(signalRate * 100).toFixed(1).padStart(6)}%   (COMPANY)`);
  console.log(`  Opaque Rate            ${(opaqueRate * 100).toFixed(1).padStart(6)}%   (PRIVACY + EMPTY)`);

  let verdict, detail;
  if (signalRate >= 0.50 && opaqueRate <= 0.40) {
    verdict = 'BUILD THE SIGNAL';
    detail  = `Signal rate ${(signalRate * 100).toFixed(1)}% clears the 50% threshold. RDAP data contains usable ownership signal.`;
  } else if (opaqueRate >= 0.60) {
    verdict = 'STOP';
    detail  = `Opaque rate ${(opaqueRate * 100).toFixed(1)}% exceeds 60% ceiling. RDAP data does not contain sufficient ownership signal.`;
  } else {
    verdict = 'INVESTIGATE FURTHER';
    detail  = `Signal ${(signalRate * 100).toFixed(1)}% / Opaque ${(opaqueRate * 100).toFixed(1)}%. Review top registrant names before deciding.`;
  }

  console.log(`\n  VERDICT`);
  console.log(`  ${'─'.repeat(W - 2)}`);
  console.log(`\n  >> ${verdict}`);
  console.log(`     ${detail}`);

  console.log(`\n  TOP 10 REGISTRANT ORG VALUES`);
  console.log(`  ${'─'.repeat(50)}`);
  if (topOrgs.length === 0) {
    console.log('  (none found)');
  } else {
    for (const [val, cnt] of topOrgs.slice(0, 10)) {
      console.log(`  ${String(cnt).padStart(5)}  ${val}`);
    }
  }

  console.log(`\n  TOP 10 REGISTRANT NAME VALUES`);
  console.log(`  ${'─'.repeat(50)}`);
  if (topNames.length === 0) {
    console.log('  (none found)');
  } else {
    for (const [val, cnt] of topNames.slice(0, 10)) {
      console.log(`  ${String(cnt).padStart(5)}  ${val}`);
    }
  }

  // ── Save outputs ───────────────────────────────────────────────────────────

  const jsonOut = { meta: { table: TABLE, total, run_at: new Date().toISOString() }, counts, signalRate, opaqueRate, verdict, detail, topOrgs, topNames };
  fs.writeFileSync(JSON_OUT, JSON.stringify(jsonOut, null, 2), 'utf8');

  writeReport(catRows, total, counts, signalRate, opaqueRate, verdict, topOrgs, topNames);

  console.log(`\n  Outputs:`);
  console.log(`    ${JSON_OUT}`);
  console.log(`    ${CSV_OUT}`);
  console.log(`\n${HR}\n`);
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
