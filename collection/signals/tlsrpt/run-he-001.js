'use strict';

// SOT-TLSRPT-001 — HE-001 University Cohort TLS-RPT Collection Run
//
// Reads the HE-001 cohort from the data.ac.uk CSV,
// runs the TLS-RPT collector against every domain,
// stores all observations in signal_facts_tlsrpt,
// and prints a full cohort analysis.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/tlsrpt/run-he-001.js
//
// Prerequisites:
//   Migration 010_signal_lab_tlsrpt.sql applied in Supabase Dashboard.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const fs   = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { collectTlsRpt, SIGNAL_ID, SIGNAL_VERSION } = require('./tlsrpt-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE = 'HE-001';
const CSV_PATH    = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const CONCURRENCY = 10;   // DNS-only signal; higher concurrency than MTA-STS

// ── Supabase ──────────────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function splitCsvLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function loadCohort() {
  const text  = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = text.split('\n').filter(l => l.trim());
  const [header, ...rows] = lines;

  const headers = splitCsvLine(header).map(h => h.trim().toLowerCase());
  const ukprnIdx    = headers.findIndex(h => h.includes('ukprn'));
  const nameIdx     = headers.findIndex(h => h === 'legal name' || h.includes('legal'));
  const websiteIdx  = headers.findIndex(h => h === 'website' || h.includes('web'));

  const institutions = [];
  const skipped      = [];

  for (const row of rows) {
    const cols    = splitCsvLine(row);
    const ukprn   = cols[ukprnIdx]?.trim() ?? '';
    const name    = cols[nameIdx]?.trim() ?? '';
    const website = cols[websiteIdx]?.trim() ?? '';

    let domain = null;
    try {
      if (website && (website.startsWith('http://') || website.startsWith('https://'))) {
        domain = new URL(website).hostname.replace(/^www\./i, '').toLowerCase();
      }
    } catch {}

    if (!domain) { skipped.push({ ukprn, name }); continue; }
    institutions.push({ ukprn, name, domain });
  }
  return { institutions, skipped };
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let   idx     = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Progress line ─────────────────────────────────────────────────────────────

function progressLine(r, domain, i, total) {
  const pct = String(Math.round(((i + 1) / total) * 100)).padStart(3);
  if (r.dns_tlsrpt_present === null) {
    return `  [${pct}%] ?  ${domain.padEnd(40)} (${r.dns_collection_error ?? 'unknown'})`;
  }
  if (r.dns_tlsrpt_present === false) {
    return `  [${pct}%] N  ${domain.padEnd(40)} (absent)`;
  }
  const parts = [`id=${r.dns_version ?? '?'}`];
  if (r.rua_count > 0) {
    if (r.rua_mailto_count > 0)          parts.push(`mailto:${r.rua_mailto_count}`);
    if (r.rua_https_count > 0)           parts.push(`https:${r.rua_https_count}`);
    if (r.rua_unknown_scheme_count > 0)  parts.push(`other:${r.rua_unknown_scheme_count}`);
  } else {
    parts.push('rua=MISSING');
  }
  if (r.dns_multiple_tlsrpt_records) parts.push('MULTI');
  return `  [${pct}%] Y  ${domain.padEnd(40)} ${parts.join('  ')}`;
}

// ── Supabase insert ───────────────────────────────────────────────────────────

async function insertRecord(supabase, domain, r) {
  const { error } = await supabase.from('signal_facts_tlsrpt').insert({
    domain,
    signal_version:              SIGNAL_VERSION,
    collected_at:                new Date().toISOString(),
    dns_tlsrpt_present:          r.dns_tlsrpt_present,
    dns_collection_error:        r.dns_collection_error,
    dns_records:                 r.dns_records,
    dns_record_count:            r.dns_record_count,
    dns_tlsrpt_record_count:     r.dns_tlsrpt_record_count,
    dns_multiple_tlsrpt_records: r.dns_multiple_tlsrpt_records,
    dns_parse_success:           r.dns_parse_success,
    dns_syntax_errors:           r.dns_syntax_errors,
    dns_version:                 r.dns_version,
    dns_unknown_tags:            r.dns_unknown_tags,
    rua_raw:                     r.rua_raw,
    rua_uris:                    r.rua_uris,
    rua_count:                   r.rua_count,
    rua_mailto_count:            r.rua_mailto_count,
    rua_https_count:             r.rua_https_count,
    rua_unknown_scheme_count:    r.rua_unknown_scheme_count,
  });
  if (error) throw new Error(`Supabase insert failed for ${domain}: ${error.message}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? '  0.0%' : `${(n / total * 100).toFixed(1).padStart(5)}%`;
}

function printSummary(results, startedAt) {
  const total    = results.length;
  const DIV      = '─'.repeat(72);
  const HR       = '═'.repeat(72);

  const present  = results.filter(r => r.dns_tlsrpt_present === true);
  const absent   = results.filter(r => r.dns_tlsrpt_present === false);
  const unknown  = results.filter(r => r.dns_tlsrpt_present === null);

  console.log(`\n${HR}`);
  console.log(` SOT-TLSRPT-001 — HE-001 COHORT SUMMARY`);
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}   n = ${total}`);
  console.log(` Collected: ${startedAt.toISOString()}`);
  console.log(`${HR}`);

  // ── 1. DNS Presence ────────────────────────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 1. DNS PRESENCE DISTRIBUTION`);
  console.log();
  console.log(`    dns_tlsrpt_present = true    : ${String(present.length).padStart(4)}   ${pct(present.length, total)}`);
  console.log(`    dns_tlsrpt_present = false   : ${String(absent.length).padStart(4)}   ${pct(absent.length, total)}`);
  console.log(`    dns_tlsrpt_present = null    : ${String(unknown.length).padStart(4)}   ${pct(unknown.length, total)}`);

  if (unknown.length > 0) {
    console.log();
    console.log(`    DNS collection error breakdown:`);
    const errorCounts = {};
    for (const r of unknown) {
      const k = r.dns_collection_error ?? 'null';
      errorCounts[k] = (errorCounts[k] ?? 0) + 1;
    }
    for (const [k, n] of Object.entries(errorCounts)) {
      console.log(`      ${k.padEnd(20)}: ${n}`);
    }
  }

  if (present.length === 0) {
    console.log(`\n${HR}\n`);
    return;
  }

  // ── 2. RUA Presence ───────────────────────────────────────────────────────

  const withRua    = present.filter(r => r.rua_count > 0);
  const withoutRua = present.filter(r => r.rua_count === 0);

  console.log(`\n${DIV}`);
  console.log(` 2. RUA PRESENCE DISTRIBUTION  (${present.length} domains with dns_tlsrpt_present = true)`);
  console.log();
  console.log(`    rua_count > 0    : ${String(withRua.length).padStart(4)}   ${pct(withRua.length, present.length)}`);
  console.log(`    rua_count = 0    : ${String(withoutRua.length).padStart(4)}   ${pct(withoutRua.length, present.length)}`);

  // ── 3. Reporting URI scheme distribution ──────────────────────────────────

  const mailtoOnly   = present.filter(r => r.rua_mailto_count > 0 && r.rua_https_count === 0);
  const httpsOnly    = present.filter(r => r.rua_https_count > 0  && r.rua_mailto_count === 0);
  const mixedScheme  = present.filter(r => r.rua_mailto_count > 0 && r.rua_https_count > 0);
  const unknownOnly  = present.filter(r => r.rua_unknown_scheme_count > 0 && r.rua_mailto_count === 0 && r.rua_https_count === 0);

  console.log(`\n${DIV}`);
  console.log(` 3. REPORTING URI SCHEME DISTRIBUTION  (${present.length} domains with dns_tlsrpt_present = true)`);
  console.log();
  console.log(`    mailto only                  : ${String(mailtoOnly.length).padStart(4)}   ${pct(mailtoOnly.length,  present.length)}`);
  console.log(`    https only                   : ${String(httpsOnly.length).padStart(4)}   ${pct(httpsOnly.length,   present.length)}`);
  console.log(`    mailto + https (mixed)       : ${String(mixedScheme.length).padStart(4)}   ${pct(mixedScheme.length, present.length)}`);
  console.log(`    unknown scheme only          : ${String(unknownOnly.length).padStart(4)}   ${pct(unknownOnly.length, present.length)}`);
  console.log(`    no rua (missing/empty)       : ${String(withoutRua.length).padStart(4)}   ${pct(withoutRua.length,  present.length)}`);

  // ── 4. Reporting URI count distribution ───────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 4. REPORTING URI COUNT DISTRIBUTION  (${present.length} domains with dns_tlsrpt_present = true)`);
  console.log();
  const ruaCounts = [0, 1, 2, 3];
  for (const n of ruaCounts) {
    const c = present.filter(r => r.rua_count === n).length;
    console.log(`    rua_count = ${n}                  : ${String(c).padStart(4)}   ${pct(c, present.length)}`);
  }
  const moreThan3 = present.filter(r => r.rua_count > 3).length;
  if (moreThan3 > 0) {
    console.log(`    rua_count > 3                : ${String(moreThan3).padStart(4)}   ${pct(moreThan3, present.length)}`);
  }

  // ── 5. Multiple records ────────────────────────────────────────────────────

  const multipleRecords = present.filter(r => r.dns_multiple_tlsrpt_records);

  console.log(`\n${DIV}`);
  console.log(` 5. MULTIPLE DNS RECORD ANALYSIS  (dns_multiple_tlsrpt_records = true)`);
  console.log();
  if (multipleRecords.length === 0) {
    console.log(`    (none — all domains returned at most one v=TLSRPTv1 record)`);
  } else {
    console.log(`    ${multipleRecords.length} domain(s) with multiple v=TLSRPTv1 records:`);
    for (const r of multipleRecords) {
      console.log(`      ${r._domain}  (count: ${r.dns_tlsrpt_record_count})`);
    }
  }

  // ── 6. Parse success distribution ─────────────────────────────────────────

  const parseSuccess = present.filter(r => r.dns_parse_success === true);
  const parseFail    = present.filter(r => r.dns_parse_success === false);

  console.log(`\n${DIV}`);
  console.log(` 6. PARSE SUCCESS DISTRIBUTION  (${present.length} domains with dns_tlsrpt_present = true)`);
  console.log();
  console.log(`    dns_parse_success = true     : ${String(parseSuccess.length).padStart(4)}   ${pct(parseSuccess.length, present.length)}`);
  console.log(`    dns_parse_success = false    : ${String(parseFail.length).padStart(4)}   ${pct(parseFail.length, present.length)}`);

  // ── 7. Syntax error inventory ──────────────────────────────────────────────

  const allErrors = present.flatMap(r => r.dns_syntax_errors ?? []);
  const errorCodes = {};
  for (const e of allErrors) {
    errorCodes[e.code] = (errorCodes[e.code] ?? 0) + 1;
  }

  console.log(`\n${DIV}`);
  console.log(` 7. DNS SYNTAX ERROR DISTRIBUTION`);
  console.log();
  if (Object.keys(errorCodes).length === 0) {
    console.log(`    (no DNS syntax errors)`);
  } else {
    for (const [code, n] of Object.entries(errorCodes)) {
      console.log(`    ${code.padEnd(32)} : ${n}`);
    }
  }

  // ── 8. Unknown tag inventory ───────────────────────────────────────────────

  const withUnknownTags = present.filter(r => Object.keys(r.dns_unknown_tags ?? {}).length > 0);

  console.log(`\n${DIV}`);
  console.log(` 8. UNKNOWN TAG INVENTORY`);
  console.log();
  if (withUnknownTags.length === 0) {
    console.log(`    Domains with unknown DNS tags: 0`);
  } else {
    console.log(`    Domains with unknown DNS tags: ${withUnknownTags.length}`);
    for (const r of withUnknownTags) {
      console.log(`      ${r._domain}: ${JSON.stringify(r.dns_unknown_tags)}`);
    }
  }

  // ── 9. Evidence review ────────────────────────────────────────────────────

  console.log(`\n${HR}`);
  console.log(` EVIDENCE REVIEW`);
  console.log(`${HR}`);

  const examplesPerMode = 2;

  const showExamples = (label, pool, limit) => {
    const sample = pool.slice(0, limit);
    if (sample.length === 0) return;
    console.log(`\n ${DIV}`);
    console.log(` ${label}  (${Math.min(pool.length, limit)} example(s))`);
    console.log(` ${DIV}`);
    for (const r of sample) {
      console.log();
      console.log(`  Domain               : ${r._domain}`);
      console.log(`  dns_version          : ${r.dns_version}`);
      console.log(`  rua_count            : ${r.rua_count}`);
      console.log(`  rua_mailto_count     : ${r.rua_mailto_count}`);
      console.log(`  rua_https_count      : ${r.rua_https_count}`);
      if (r.rua_uris.length > 0) {
        for (let i = 0; i < r.rua_uris.length; i++) {
          console.log(`  rua_uris[${i}]         : ${r.rua_uris[i]}`);
        }
      }
      console.log(`  dns_parse_success    : ${r.dns_parse_success}`);
      if (r.dns_records.length > 0) {
        const preview = r.dns_records[0].slice(0, 100);
        console.log(`  dns_records[0]       : "${preview}${r.dns_records[0].length > 100 ? '...' : ''}"`);
      }
      if (Object.keys(r.dns_unknown_tags ?? {}).length > 0) {
        console.log(`  dns_unknown_tags     : ${JSON.stringify(r.dns_unknown_tags)}`);
      }
    }
  };

  showExamples('mailto reporting (examples)', mailtoOnly, examplesPerMode);
  showExamples('https reporting (examples)', httpsOnly, examplesPerMode);
  showExamples('mixed mailto + https (examples)', mixedScheme, examplesPerMode);
  showExamples('multiple URIs (rua_count > 1)', present.filter(r => r.rua_count > 1), examplesPerMode);
  showExamples('multiple TLS-RPT records (MULTIPLE_RECORDS)', multipleRecords, examplesPerMode);
  showExamples('unknown tags (examples)', withUnknownTags, examplesPerMode);
  showExamples('parse failures (dns_parse_success = false)', parseFail, examplesPerMode);

  console.log(`\n${HR}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR  = '═'.repeat(72);
  const startedAt = new Date();

  console.log(`\n${HR}`);
  console.log(` SOT-TLSRPT-001 — HE-001 University Cohort TLS-RPT Collection`);
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}`);
  console.log(` Started: ${startedAt.toISOString()}`);
  console.log(HR);

  const { institutions, skipped } = loadCohort();
  const supabase = getClient();

  console.log(`\n  Cohort: ${institutions.length} institutions loaded from CSV`);
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.length} institution(s):`);
    for (const s of skipped) console.log(`    • UKPRN ${s.ukprn}  ${s.name}  [unparseable URL]`);
  }
  console.log(`  Supabase: signal_facts_tlsrpt ready`);

  // Verify table is accessible
  const { error: tableErr } = await supabase.from('signal_facts_tlsrpt').select('id').limit(1);
  if (tableErr) throw new Error(`Cannot access signal_facts_tlsrpt: ${tableErr.message}\nApply migration 010_signal_lab_tlsrpt.sql first.`);

  console.log(`\n\n${HR}`);
  console.log(` Collecting — ${institutions.length} institutions  concurrency: ${CONCURRENCY}`);
  console.log(`${HR}\n`);
  console.log(`  Legend:  Y present   N absent   ? unknown\n`);

  const t0      = Date.now();
  const results = await runWithConcurrency(institutions, async ({ domain }, i) => {
    const r = await collectTlsRpt(domain);
    console.log(progressLine(r, domain, i, institutions.length));
    await insertRecord(supabase, domain, r);
    r._domain = domain;
    return r;
  }, CONCURRENCY);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  Completed: ${institutions.length} institutions in ${elapsed}s`);

  printSummary(results, startedAt);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
