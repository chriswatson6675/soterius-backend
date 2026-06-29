'use strict';

// SOT-SECURITYTXT-001 — HE-001 University Cohort Collection Run
//
// Reads the 166-institution HE-001 cohort from the data.ac.uk CSV,
// runs the security.txt collector against every domain in parallel,
// writes all evidence to signal_securitytxt_v1, and prints a cohort summary.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/securitytxt/run-he-001.js
//
// Prerequisites:
//   Migration 013_signal_lab_securitytxt.sql applied in Supabase Dashboard.
//
// Environment:
//   SUPABASE_URL             — required
//   SUPABASE_SERVICE_ROLE_KEY — required
//   CONCURRENCY              — optional, default 10
//   RUN_ID                   — optional UUID; set to resume a failed run

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const fs             = require('node:fs');
const path           = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { collectSecurityTxt } = require('./securitytxt-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE       = 'HE-001';
const COLLECTOR_VERSION = '1.0.0';
const CSV_PATH          = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const CONCURRENCY       = Number(process.env.CONCURRENCY ?? 10);
const RUN_ID            = process.env.RUN_ID ?? randomUUID();

// ── Supabase client ───────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  }
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
  const raw     = fs.readFileSync(CSV_PATH, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines   = raw.split('\n').filter(l => l.trim());
  const headers = splitCsvLine(lines[0]);

  const ukprnIdx    = headers.indexOf('UKPRN');
  const viewNameIdx = headers.indexOf('VIEW_NAME');
  const provNameIdx = headers.indexOf('PROVIDER_NAME');
  const urlIdx      = headers.indexOf('WEBSITE_URL');

  const institutions = [];
  const skipped      = [];

  for (const line of lines.slice(1)) {
    const f      = splitCsvLine(line);
    const rawUrl = f[urlIdx]?.trim();
    const name   = f[viewNameIdx]?.trim() || f[provNameIdx]?.trim() || '(unknown)';
    const ukprn  = f[ukprnIdx]?.trim() ?? '';

    if (!rawUrl) {
      skipped.push({ ukprn, name, reason: 'missing WEBSITE_URL' });
      continue;
    }

    let domain;
    try {
      domain = new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      skipped.push({ ukprn, name, reason: `unparseable URL: ${rawUrl}` });
      continue;
    }

    if (!domain) {
      skipped.push({ ukprn, name, reason: `no hostname in: ${rawUrl}` });
      continue;
    }

    institutions.push({ ukprn, name, domain });
  }

  return { institutions, skipped };
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let   next    = 0;

  async function worker() {
    while (next < items.length) {
      const i    = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Supabase repository ───────────────────────────────────────────────────────

async function insertRecord(supabase, record) {
  const { error } = await supabase.from('signal_securitytxt_v1').insert({
    run_id:            RUN_ID,
    domain:            record.domain,
    collected_at:      record.collected_at,
    signal_version:    record.signal_version,
    collector_version: record.collector_version,
    file_state:        record.file_state,
    canonical_fetch:   record.canonical_fetch,
    legacy_fetch:      record.legacy_fetch,
    canonical_parse:   record.canonical_parse,
    legacy_parse:      record.legacy_parse,
  });
  return error ?? null;
}

// ── Progress logging ──────────────────────────────────────────────────────────

function progressLine(record, domain, i, total) {
  const pct     = String(Math.round(((i + 1) / total) * 100)).padStart(3);
  const fs      = record.file_state;
  const parse   = record.canonical_parse ?? record.legacy_parse;

  const stateLabel = {
    PRESENT_CANONICAL:  'CANONICAL ',
    PRESENT_LEGACY_ONLY:'LEGACY    ',
    PRESENT_BOTH:       'BOTH      ',
    ABSENT:             'ABSENT    ',
    INDETERMINATE:      'INDETERM. ',
  }[fs] ?? fs.padEnd(10);

  let detail = '';
  if (parse) {
    detail += `[${parse.content_state}]`;
    if (parse.contact.length)   detail += `  Contact=${parse.contact.length}`;
    if (parse.expires.length)   detail += `  Expires=${parse.expires.length}`;
    if (parse.policy.length)    detail += `  Policy=${parse.policy.length}`;
    if (parse.unknown_field_count > 0) detail += `  unk=${parse.unknown_field_count}`;
  } else {
    const cf = record.canonical_fetch.fetch_state;
    const lf = record.legacy_fetch.fetch_state;
    const notes = [];
    if (cf !== 'NOT_FOUND' && cf !== 'FOUND_EMPTY') notes.push(`can:${cf}`);
    if (lf !== 'NOT_FOUND' && lf !== 'FOUND_EMPTY') notes.push(`leg:${lf}`);
    if (notes.length) detail = notes.join('  ');
  }

  return `  [${pct}%]  ${domain.padEnd(40)} ${stateLabel}  ${detail}`;
}

// ── Summary computation ───────────────────────────────────────────────────────

function computeSummary(rows) {
  const total = rows.length;

  // File state distribution
  const byFileState = {};
  for (const { record } of rows) {
    const k = record?.file_state ?? 'COLLECTOR_ERROR';
    byFileState[k] = (byFileState[k] ?? 0) + 1;
  }

  // Among present domains, get parse results
  const presentRows = rows.filter(r =>
    r.record && (
      r.record.file_state === 'PRESENT_CANONICAL' ||
      r.record.file_state === 'PRESENT_LEGACY_ONLY' ||
      r.record.file_state === 'PRESENT_BOTH'
    ),
  );

  // Content state distribution
  const byContentState = {};
  for (const { record } of presentRows) {
    const parse = record.canonical_parse ?? record.legacy_parse;
    const k     = parse?.content_state ?? 'PARSE_NULL';
    byContentState[k] = (byContentState[k] ?? 0) + 1;
  }

  // RFC 9116 field presence counts
  const fieldCounts = {
    contact: 0, expires: 0, encryption: 0,
    acknowledgments: 0, policy: 0, preferred_languages: 0,
    hiring: 0, canonical: 0,
  };
  let hasUnknownFields    = 0;
  let hasMalformedLines   = 0;
  const unknownFieldNames = {};

  for (const { record } of presentRows) {
    const parse = record.canonical_parse ?? record.legacy_parse;
    if (!parse) continue;
    for (const field of Object.keys(fieldCounts)) {
      if (parse[field]?.length > 0) fieldCounts[field]++;
    }
    if (parse.unknown_field_count > 0) {
      hasUnknownFields++;
      for (const uf of parse.unknown_fields) {
        const k = uf.field_name_raw;
        unknownFieldNames[k] = (unknownFieldNames[k] ?? 0) + 1;
      }
    }
    if (parse.malformed_line_count > 0) hasMalformedLines++;
  }

  // Fetch error breakdown
  const fetchErrors = {};
  for (const { record } of rows) {
    if (!record) continue;
    for (const fetchResult of [record.canonical_fetch, record.legacy_fetch]) {
      const state = fetchResult.fetch_state;
      if (!['FOUND', 'FOUND_EMPTY', 'NOT_FOUND'].includes(state)) {
        fetchErrors[state] = (fetchErrors[state] ?? 0) + 1;
      }
    }
  }

  // Collector exceptions
  const collectorErrors = rows.filter(r => !r.record).length;
  const dbWriteErrors   = rows.filter(r => r.dbError).length;

  return {
    total, byFileState, presentRows,
    byContentState, fieldCounts, hasUnknownFields,
    hasMalformedLines, unknownFieldNames, fetchErrors,
    collectorErrors, dbWriteErrors,
  };
}

// ── Summary output ────────────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? '  0.0%' : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function printSummary(s, startedAt, skipped) {
  const HR  = '═'.repeat(72);
  const DIV = '─'.repeat(72);

  console.log(`\n${HR}`);
  console.log(` SOT-SECURITYTXT-001 — HE-001 COHORT SUMMARY`);
  console.log(` Signal: SOT-SECURITYTXT-001 v1   Cohort: ${COHORT_CODE}   n = ${s.total}`);
  console.log(` Collected: ${startedAt.toISOString()}`);
  console.log(` Run ID: ${RUN_ID}`);
  if (skipped.length > 0) {
    console.log(` Source data: ${skipped.length} institution(s) skipped — no queryable domain in CSV`);
  }
  console.log(HR);

  // 1. File state distribution
  console.log('\n 1. FILE STATE DISTRIBUTION\n');
  const stateOrder = [
    'PRESENT_CANONICAL', 'PRESENT_LEGACY_ONLY', 'PRESENT_BOTH',
    'ABSENT', 'INDETERMINATE', 'COLLECTOR_ERROR',
  ];
  for (const state of stateOrder) {
    const n = s.byFileState[state] ?? 0;
    if (n > 0) {
      console.log(`    ${state.padEnd(24)}: ${String(n).padStart(4)}   ${pct(n, s.total)}`);
    }
  }
  const presentCount = (s.byFileState['PRESENT_CANONICAL'] ?? 0) +
                       (s.byFileState['PRESENT_LEGACY_ONLY'] ?? 0) +
                       (s.byFileState['PRESENT_BOTH'] ?? 0);
  console.log(`\n    security.txt present (any): ${String(presentCount).padStart(4)}   ${pct(presentCount, s.total)}`);

  if (s.presentRows.length === 0) {
    console.log(`\n${HR}\n`);
    return;
  }

  // 2. Content state distribution
  const np = s.presentRows.length;
  console.log(`\n${DIV}`);
  console.log(`\n 2. CONTENT STATE DISTRIBUTION  (${np} domains with file present)\n`);
  const contentOrder = ['UNSIGNED', 'SIGNED', 'MALFORMED_PGP'];
  for (const cs of contentOrder) {
    const n = s.byContentState[cs] ?? 0;
    if (n > 0) {
      console.log(`    ${cs.padEnd(16)}: ${String(n).padStart(4)}   ${pct(n, np)}`);
    }
  }

  // 3. RFC 9116 field presence
  console.log(`\n${DIV}`);
  console.log(`\n 3. RFC 9116 FIELD PRESENCE  (${np} domains with file present)\n`);
  const fieldOrder = [
    ['contact',             'Contact           '],
    ['expires',             'Expires           '],
    ['encryption',          'Encryption        '],
    ['acknowledgments',     'Acknowledgments   '],
    ['policy',              'Policy            '],
    ['preferred_languages', 'Preferred-Languages'],
    ['hiring',              'Hiring            '],
    ['canonical',           'Canonical         '],
  ];
  for (const [key, label] of fieldOrder) {
    const n = s.fieldCounts[key];
    if (n > 0) {
      console.log(`    ${label}: ${String(n).padStart(4)}   ${pct(n, np)}`);
    }
  }

  // 4. Unknown fields
  if (s.hasUnknownFields > 0) {
    console.log(`\n${DIV}`);
    console.log(`\n 4. UNKNOWN FIELDS  (${s.hasUnknownFields} domains with unknown fields)\n`);
    const sorted = Object.entries(s.unknownFieldNames).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      console.log(`    ${name.padEnd(32)}: ${String(count).padStart(4)}`);
    }
  }

  // 5. Content quality observations
  console.log(`\n${DIV}`);
  console.log(`\n 5. CONTENT OBSERVATIONS  (${np} domains with file present)\n`);
  console.log(`    Has unknown fields    : ${String(s.hasUnknownFields).padStart(4)}   ${pct(s.hasUnknownFields, np)}`);
  console.log(`    Has malformed lines   : ${String(s.hasMalformedLines).padStart(4)}   ${pct(s.hasMalformedLines, np)}`);

  // 6. Fetch error breakdown
  const errorEntries = Object.entries(s.fetchErrors).sort((a, b) => b[1] - a[1]);
  if (errorEntries.length > 0) {
    console.log(`\n${DIV}`);
    console.log('\n 6. FETCH ERROR BREAKDOWN  (counts both canonical + legacy fetches)\n');
    for (const [state, n] of errorEntries) {
      console.log(`    ${state.padEnd(22)}: ${String(n).padStart(4)}`);
    }
  }

  // 7. Run health
  console.log(`\n${DIV}`);
  console.log('\n 7. RUN HEALTH\n');
  console.log(`    Collector exceptions  : ${String(s.collectorErrors).padStart(4)}`);
  console.log(`    DB write failures     : ${String(s.dbWriteErrors).padStart(4)}`);
  if (s.dbWriteErrors > 0) {
    console.log(`\n    WARNING: some rows were not written to signal_securitytxt_v1.`);
    console.log(`    Re-run with RUN_ID=${RUN_ID} to retry only the failed domains.`);
  }

  console.log(`\n${HR}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR        = '═'.repeat(72);
  const startedAt = new Date();

  console.log(`\n${HR}`);
  console.log(` SOT-SECURITYTXT-001 — HE-001 University Cohort Collection`);
  console.log(` Signal: SOT-SECURITYTXT-001 v1   Cohort: ${COHORT_CODE}`);
  console.log(` Started: ${startedAt.toISOString()}`);
  console.log(` Run ID: ${RUN_ID}`);
  console.log(` Concurrency: ${CONCURRENCY}`);
  console.log(HR);

  // Load cohort from CSV
  const { institutions, skipped } = loadCohort();
  console.log(`\n  Cohort: ${institutions.length} institutions loaded`);
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.length} institution(s) with no queryable domain:`);
    for (const s of skipped) {
      console.log(`    • UKPRN ${s.ukprn}  ${s.name}  [${s.reason}]`);
    }
  }

  // Verify Supabase connection and table
  const supabase = getClient();
  const { error: pingErr } = await supabase
    .from('signal_securitytxt_v1')
    .select('id')
    .limit(1);

  if (pingErr) {
    const missing = pingErr.message.includes('does not exist') || pingErr.code === '42P01';
    if (missing) {
      console.error('\n  ERROR: signal_securitytxt_v1 table not found.');
      console.error('  Apply backend/db/migrations/013_signal_lab_securitytxt.sql in Supabase first.\n');
    } else {
      console.error(`\n  ERROR: Supabase connection failed — ${pingErr.message}\n`);
    }
    process.exit(1);
  }
  console.log('  Supabase: signal_securitytxt_v1 ready\n');

  console.log(`${HR}`);
  console.log(` Collecting — ${institutions.length} institutions  concurrency: ${CONCURRENCY}`);
  console.log(`${HR}\n`);

  const t0 = Date.now();

  const rows = await runWithConcurrency(institutions, async (inst, i) => {
    // ── Collector ─────────────────────────────────────────────────────────────
    let record = null;
    let collectorError = null;

    try {
      record = await collectSecurityTxt(inst.domain, COLLECTOR_VERSION);
    } catch (err) {
      collectorError = err.message ?? String(err);
    }

    // ── DB write ──────────────────────────────────────────────────────────────
    let dbError = null;
    if (record) {
      try {
        dbError = await insertRecord(supabase, record);
      } catch (err) {
        dbError = { message: err.message ?? String(err) };
      }
    }

    // ── Progress line ─────────────────────────────────────────────────────────
    let line;
    if (record) {
      line = progressLine(record, inst.domain, i, institutions.length);
    } else {
      const pct = String(Math.round(((i + 1) / institutions.length) * 100)).padStart(3);
      line = `  [${pct}%]  ${inst.domain.padEnd(40)} COLLECTOR_ERROR  ${collectorError}`;
    }
    if (dbError) line += `  [DB ERR: ${dbError.message}]`;
    console.log(line);

    return { ...inst, record, collectorError, dbError };
  }, CONCURRENCY);

  const elapsed   = ((Date.now() - t0) / 1000).toFixed(1);
  const dbErrs    = rows.filter(r => r.dbError).length;
  const colErrs   = rows.filter(r => r.collectorError).length;

  console.log(`\n  Completed: ${institutions.length} institutions in ${elapsed}s`);
  if (dbErrs  > 0) console.log(`  WARNING: ${dbErrs} database write(s) failed`);
  if (colErrs > 0) console.log(`  WARNING: ${colErrs} collector exception(s)`);

  const summary = computeSummary(rows);
  printSummary(summary, startedAt, skipped);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
