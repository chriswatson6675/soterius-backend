'use strict';

// SOT-SPF-001 — HE-001 University Cohort SPF Collection Run
//
// Reads the 166-institution HE-001 cohort from the data.ac.uk CSV,
// runs the SPF collector against every domain, stores raw observations
// in signal_facts_spf, and prints a cohort summary.
//
// Usage:
//   node backend/signal-lab/signals/spf/run-he-001.js
//
// Prerequisites:
//   Migration 006_signal_lab_spf.sql applied in Supabase Dashboard.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { collectSpf, SIGNAL_ID, SIGNAL_VERSION } = require('./spf-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE = 'HE-001';
const CSV_PATH    = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const CONCURRENCY = 10;   // simultaneous DNS queries

// ── Supabase ──────────────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — check backend/.env',
    );
  }
  return createClient(url, key);
}

// ── CSV parsing ───────────────────────────────────────────────────────────────
// Same logic as scripts/pipeline/import.js — handles quoted fields and "" escapes.

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
  const skipped      = [];   // source data quality issues

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
      skipped.push({ ukprn, name, reason: `no hostname in URL: ${rawUrl}` });
      continue;
    }

    institutions.push({ ukprn, name, domain });
  }

  return { institutions, skipped };
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Database storage ──────────────────────────────────────────────────────────

async function saveObservation(client, domain, facts) {
  const { error } = await client.from('signal_facts_spf').insert({
    domain,
    signal_version:       SIGNAL_VERSION,
    spf_present:          facts.spf_present,
    spf_collection_error: facts.spf_collection_error,
    spf_record:           facts.spf_record,
    spf_record_count:     facts.spf_record_count,
    spf_parse_success:    facts.spf_parse_success,
    spf_syntax_errors:    facts.spf_syntax_errors,
    spf_mechanism:        facts.spf_mechanism,
    spf_lookup_count:     facts.spf_lookup_count,
    spf_multiple_records: facts.spf_multiple_records,
    spf_include_count:    facts.spf_include_count,
  });
  return error ?? null;
}

// ── Collection run ────────────────────────────────────────────────────────────

async function collect(institutions, client) {
  const total     = institutions.length;
  const startedAt = Date.now();
  let   completed = 0;

  const div = '─'.repeat(64);
  console.log(`\n${div}`);
  console.log(` Collecting — ${total} institutions  concurrency: ${CONCURRENCY}`);
  console.log(`${div}\n`);
  console.log('  Legend:  ✓ present   ∅ absent   ? unknown (DNS uncertain)\n');

  const observations = await runWithConcurrency(institutions, async (inst) => {
    const facts = await collectSpf(inst.domain);
    const dbErr = await saveObservation(client, inst.domain, facts);
    completed++;

    const pct    = String(Math.round((completed / total) * 100)).padStart(3);
    const symbol = facts.spf_present === true ? '✓' : facts.spf_present === false ? '∅' : '?';
    const mech   = (facts.spf_mechanism ?? '').padEnd(5);
    const errs   = facts.spf_syntax_errors?.length
      ? ` [${facts.spf_syntax_errors.map(e => e.code).join(', ')}]`
      : '';
    const dbNote = dbErr ? ` [DB: ${dbErr.message}]` : '';

    console.log(`  [${pct}%] ${symbol}  ${inst.domain.padEnd(36)} ${mech}${errs}${dbNote}`);

    return { ...inst, facts, dbErr };
  }, CONCURRENCY);

  const elapsed  = ((Date.now() - startedAt) / 1000).toFixed(1);
  const dbErrors = observations.filter(o => o.dbErr).length;

  console.log(`\n  Completed: ${total} institutions in ${elapsed}s`);
  if (dbErrors > 0) console.log(`  WARNING: ${dbErrors} database write(s) failed`);

  return observations;
}

// ── Summary computation ───────────────────────────────────────────────────────

function computeSummary(observations) {
  const total = observations.length;

  // 1. Presence distribution
  const presence = { present: 0, absent: 0, unknown: 0 };
  for (const { facts: f } of observations) {
    if      (f.spf_present === true)  presence.present++;
    else if (f.spf_present === false) presence.absent++;
    else                              presence.unknown++;
  }

  // 2. Mechanism distribution — only where spf_present = true
  const mechanism = { '-all': 0, '~all': 0, '?all': 0, '+all': 0, none: 0 };
  for (const { facts: f } of observations.filter(o => o.facts.spf_present === true)) {
    const m = f.spf_mechanism;
    if (m === '-all' || m === '~all' || m === '?all' || m === '+all') mechanism[m]++;
    else mechanism.none++;
  }

  // 3–5. Count distributions
  const recordCounts  = {};
  const includeCounts = {};
  const lookupCounts  = {};

  for (const { facts: f } of observations) {
    if (f.spf_record_count !== null) {
      const k = f.spf_record_count;
      recordCounts[k] = (recordCounts[k] ?? 0) + 1;
    }
  }
  for (const { facts: f } of observations.filter(o => o.facts.spf_present === true)) {
    if (f.spf_include_count !== null) {
      const k = f.spf_include_count;
      includeCounts[k] = (includeCounts[k] ?? 0) + 1;
    }
    if (f.spf_lookup_count !== null) {
      const k = f.spf_lookup_count;
      lookupCounts[k] = (lookupCounts[k] ?? 0) + 1;
    }
  }

  // 6. Syntax error distribution — across all observations
  const syntaxErrors = {};
  for (const { facts: f } of observations) {
    for (const e of (f.spf_syntax_errors ?? [])) {
      syntaxErrors[e.code] = (syntaxErrors[e.code] ?? 0) + 1;
    }
  }

  // 7. Flagged institutions
  const parseFailed     = observations.filter(o => o.facts.spf_parse_success === false);
  const multipleRecords = observations.filter(o => (o.facts.spf_record_count ?? 0) > 1);
  const lookupExceeded  = observations.filter(o => (o.facts.spf_lookup_count ?? 0) > 10);

  return {
    total, presence, mechanism,
    recordCounts, includeCounts, lookupCounts,
    syntaxErrors, parseFailed, multipleRecords, lookupExceeded,
  };
}

// ── Summary output ────────────────────────────────────────────────────────────

function pct(n, of) {
  if (of === 0) return '  0.0%';
  return `${((n / of) * 100).toFixed(1).padStart(5)}%`;
}

function countTable(counts, unitSingular, unitPlural) {
  const keys = Object.keys(counts).map(Number).sort((a, b) => a - b);
  if (keys.length === 0) { console.log('    (no data)'); return; }
  for (const k of keys) {
    const unit = k === 1 ? unitSingular : unitPlural;
    console.log(`    ${String(k).padStart(3)} ${unit.padEnd(8)} : ${String(counts[k]).padStart(4)}`);
  }
}

function flaggedSection(label, items, detailFn) {
  console.log(`    ${label}  (${items.length})`);
  if (items.length === 0) {
    console.log('      none\n');
    return;
  }
  for (const item of items) {
    console.log(`      • ${item.name}`);
    console.log(`        ${item.domain}  ${detailFn(item.facts)}`);
  }
  console.log('');
}

function printSummary(s, collectedAt, skipped = []) {
  const hr  = '═'.repeat(64);
  const div = '─'.repeat(64);

  console.log('\n' + hr);
  console.log(` SOT-SPF-001 — HE-001 COHORT SUMMARY`);
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}   n = ${s.total}`);
  console.log(` Collected: ${collectedAt}`);
  if (skipped.length > 0) {
    console.log(` Source data: ${skipped.length} institution(s) skipped — no queryable domain in CSV`);
    for (const sk of skipped) console.log(`   UKPRN ${sk.ukprn}  ${sk.name}  [${sk.reason}]`);
  }
  console.log(hr);

  // 1. Presence
  console.log('\n 1. SPF PRESENCE DISTRIBUTION\n');
  const { present: pr, absent: ab, unknown: un } = s.presence;
  console.log(`    Present  (spf_present = true)  : ${String(pr).padStart(4)}  ${pct(pr, s.total)}`);
  console.log(`    Absent   (spf_present = false) : ${String(ab).padStart(4)}  ${pct(ab, s.total)}`);
  console.log(`    Unknown  (spf_present = null)  : ${String(un).padStart(4)}  ${pct(un, s.total)}`);

  // 2. Mechanism
  console.log('\n' + div);
  console.log('\n 2. SPF MECHANISM DISTRIBUTION  (where spf_present = true)\n');
  for (const [k, v] of Object.entries(s.mechanism)) {
    console.log(`    ${k.padEnd(8)} : ${String(v).padStart(4)}  ${pct(v, pr)}`);
  }

  // 3. Record count
  console.log('\n' + div);
  console.log('\n 3. SPF RECORD COUNT DISTRIBUTION\n');
  countTable(s.recordCounts, 'record', 'records');

  // 4. Include count
  console.log('\n' + div);
  console.log('\n 4. SPF INCLUDE COUNT DISTRIBUTION  (where spf_present = true)\n');
  countTable(s.includeCounts, 'include', 'includes');

  // 5. Lookup count
  console.log('\n' + div);
  console.log('\n 5. SPF LOOKUP COUNT DISTRIBUTION  (where spf_present = true)\n');
  countTable(s.lookupCounts, 'lookup', 'lookups');

  // 6. Syntax errors
  console.log('\n' + div);
  console.log('\n 6. SYNTAX ERROR DISTRIBUTION\n');
  const seEntries = Object.entries(s.syntaxErrors).sort((a, b) => b[1] - a[1]);
  if (seEntries.length === 0) {
    console.log('    (none detected)');
  } else {
    for (const [code, count] of seEntries) {
      console.log(`    ${code.padEnd(30)} : ${String(count).padStart(4)}`);
    }
  }

  // 7. Flagged institutions
  console.log('\n' + div);
  console.log('\n 7. FLAGGED INSTITUTIONS\n');

  flaggedSection(
    'spf_parse_success = false',
    s.parseFailed,
    f => {
      const codes = (f.spf_syntax_errors ?? []).map(e => e.code).join(', ');
      return codes ? `[${codes}]` : '';
    },
  );

  flaggedSection(
    'spf_record_count > 1',
    s.multipleRecords,
    f => `[record_count: ${f.spf_record_count}]`,
  );

  flaggedSection(
    'spf_lookup_count > 10',
    s.lookupExceeded,
    f => `[lookup_count: ${f.spf_lookup_count}]`,
  );

  console.log(hr + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const collectedAt = new Date().toISOString();

  console.log('\n' + '═'.repeat(64));
  console.log(' SOT-SPF-001 — HE-001 University Cohort SPF Collection');
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}`);
  console.log(` Started: ${collectedAt}`);
  console.log('═'.repeat(64));

  // Load and verify cohort
  const { institutions, skipped } = loadCohort();
  console.log(`\n  Cohort: ${institutions.length} institutions loaded from CSV`);
  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.length} institution(s) — source data quality issue:`);
    for (const s of skipped) {
      console.log(`    • UKPRN ${s.ukprn}  ${s.name}  [${s.reason}]`);
    }
  }

  // Verify Supabase connection and table
  const client = getClient();
  const { error: pingErr } = await client.from('signal_facts_spf').select('id').limit(1);
  if (pingErr) {
    const tableGone = pingErr.message.includes('does not exist') || pingErr.code === '42P01';
    if (tableGone) {
      console.error('\n  ERROR: signal_facts_spf table not found.');
      console.error('  Apply backend/db/migrations/006_signal_lab_spf.sql in Supabase first.\n');
    } else {
      console.error(`\n  ERROR: Supabase connection failed — ${pingErr.message}\n`);
    }
    process.exit(1);
  }
  console.log('  Supabase: signal_facts_spf ready');

  // Collect and store observations
  const observations = await collect(institutions, client);

  // Compute and print summary
  const summary = computeSummary(observations);
  printSummary(summary, collectedAt, skipped);
}

main().catch(e => {
  console.error('\nFatal:', e.message);
  process.exit(1);
});
