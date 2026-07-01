'use strict';

// SOT-DNSSEC-001 — HE-001 University Cohort DNSSEC Collection Run
//
// Reads the HE-001 cohort from the data.ac.uk CSV,
// runs the DNSSEC collector against every domain,
// stores all observations in signal_facts_dnssec,
// and prints a full cohort analysis.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/dnssec/run-he-001.js
//
// Prerequisites:
//   Migration 011_signal_lab_dnssec.sql applied in Supabase Dashboard.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const fs   = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { collectDnssec, SIGNAL_ID, SIGNAL_VERSION } = require('./dnssec-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE = 'HE-001';
const CSV_PATH    = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const CONCURRENCY = 10;

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

  const headers    = splitCsvLine(header).map(h => h.trim().toLowerCase());
  const ukprnIdx   = headers.findIndex(h => h.includes('ukprn'));
  const nameIdx    = headers.findIndex(h => h === 'legal name' || h.includes('legal'));
  const websiteIdx = headers.findIndex(h => h === 'website' || h.includes('web'));

  const institutions = [];
  const skipped      = [];

  for (const row of rows) {
    const cols    = splitCsvLine(row);
    const ukprn   = cols[ukprnIdx]?.trim() ?? '';
    const name    = cols[nameIdx]?.trim()  ?? '';
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
      const i    = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Progress line ─────────────────────────────────────────────────────────────

function progressLine(r, domain, i, total) {
  const pct = String(Math.round(((i + 1) / total) * 100)).padStart(3);
  const ds  = r.dns_ds_present;
  const dk  = r.dns_dnskey_present;

  const dsStr = ds === true ? 'DS:Y' : ds === false ? 'DS:N' : `DS:?(${r.ds_collection_error ?? '?'})`;
  const dkStr = dk === true ? 'DK:Y' : dk === false ? 'DK:N' : `DK:?(${r.dnskey_collection_error ?? '?'})`;

  let extra = '';
  if (ds === true) {
    extra += `  algs=[${r.ds_algorithms.join(',')}]`;
    if (r.ds_record_count > 1) extra += `  ds_n=${r.ds_record_count}`;
  }
  if (dk === true) {
    extra += `  ksk=${r.dnskey_ksk_count}  zsk=${r.dnskey_zsk_count}`;
  }

  return `  [${pct}%]  ${domain.padEnd(42)} ${dsStr}  ${dkStr}${extra}`;
}

// ── Supabase insert ───────────────────────────────────────────────────────────

async function insertRecord(supabase, domain, r) {
  const { error } = await supabase.from('signal_facts_dnssec').insert({
    domain,
    signal_version:            SIGNAL_VERSION,
    collected_at:              new Date().toISOString(),
    dns_ds_present:            r.dns_ds_present,
    ds_collection_error:       r.ds_collection_error,
    ds_records:                r.ds_records,
    ds_record_count:           r.ds_record_count,
    ds_algorithms:             r.ds_algorithms,
    ds_digest_types:           r.ds_digest_types,
    ds_key_tags:               r.ds_key_tags,
    dns_dnskey_present:        r.dns_dnskey_present,
    dnskey_collection_error:   r.dnskey_collection_error,
    dnskey_records:            r.dnskey_records,
    dnskey_record_count:       r.dnskey_record_count,
    dnskey_ksk_count:          r.dnskey_ksk_count,
    dnskey_zsk_count:          r.dnskey_zsk_count,
    dnskey_other_flags_count:  r.dnskey_other_flags_count,
    dnskey_algorithms:         r.dnskey_algorithms,
    dnskey_key_tags:           r.dnskey_key_tags,
  });
  if (error) throw new Error(`Supabase insert failed for ${domain}: ${error.message}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? '  0.0%' : `${(n / total * 100).toFixed(1).padStart(5)}%`;
}

function printSummary(results, startedAt) {
  const total = results.length;
  const DIV   = '─'.repeat(72);
  const HR    = '═'.repeat(72);

  const dsPresent  = results.filter(r => r.dns_ds_present === true);
  const dsAbsent   = results.filter(r => r.dns_ds_present === false);
  const dsUnknown  = results.filter(r => r.dns_ds_present === null);

  const dkPresent  = results.filter(r => r.dns_dnskey_present === true);
  const dkAbsent   = results.filter(r => r.dns_dnskey_present === false);
  const dkUnknown  = results.filter(r => r.dns_dnskey_present === null);

  console.log(`\n${HR}`);
  console.log(` SOT-DNSSEC-001 — HE-001 COHORT SUMMARY`);
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}   n = ${total}`);
  console.log(` Collected: ${startedAt.toISOString()}`);
  console.log(HR);

  // ── 1. DS presence distribution ───────────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 1. DS PRESENCE DISTRIBUTION  (parent zone)`);
  console.log();
  console.log(`    dns_ds_present = true    : ${String(dsPresent.length).padStart(4)}   ${pct(dsPresent.length, total)}`);
  console.log(`    dns_ds_present = false   : ${String(dsAbsent.length).padStart(4)}   ${pct(dsAbsent.length, total)}`);
  console.log(`    dns_ds_present = null    : ${String(dsUnknown.length).padStart(4)}   ${pct(dsUnknown.length, total)}`);

  if (dsUnknown.length > 0) {
    console.log();
    console.log(`    DS collection error breakdown:`);
    const errs = {};
    for (const r of dsUnknown) { const k = r.ds_collection_error ?? 'null'; errs[k] = (errs[k] ?? 0) + 1; }
    for (const [k, n] of Object.entries(errs)) console.log(`      ${k.padEnd(20)}: ${n}`);
  }

  // ── 2. DNSKEY presence distribution ──────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 2. DNSKEY PRESENCE DISTRIBUTION  (domain zone)`);
  console.log();
  console.log(`    dns_dnskey_present = true    : ${String(dkPresent.length).padStart(4)}   ${pct(dkPresent.length, total)}`);
  console.log(`    dns_dnskey_present = false   : ${String(dkAbsent.length).padStart(4)}   ${pct(dkAbsent.length, total)}`);
  console.log(`    dns_dnskey_present = null    : ${String(dkUnknown.length).padStart(4)}   ${pct(dkUnknown.length, total)}`);

  // ── 3. DS ↔ DNSKEY relationship ───────────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 3. DS ↔ DNSKEY RELATIONSHIP`);
  console.log();
  const groups = [
    ['DS=true,  DNSKEY=true  (properly configured)',  r => r.dns_ds_present === true  && r.dns_dnskey_present === true],
    ['DS=true,  DNSKEY=false (delegation without keys)', r => r.dns_ds_present === true  && r.dns_dnskey_present === false],
    ['DS=true,  DNSKEY=null  (delegation; DNSKEY unknown)', r => r.dns_ds_present === true  && r.dns_dnskey_present === null],
    ['DS=false, DNSKEY=true  (keys without delegation)', r => r.dns_ds_present === false && r.dns_dnskey_present === true],
    ['DS=false, DNSKEY=false (no DNSSEC at any level)', r => r.dns_ds_present === false && r.dns_dnskey_present === false],
    ['DS=false, DNSKEY=null  ',                        r => r.dns_ds_present === false && r.dns_dnskey_present === null],
    ['DS=null,  DNSKEY=true  ',                        r => r.dns_ds_present === null  && r.dns_dnskey_present === true],
    ['DS=null,  DNSKEY=false ',                        r => r.dns_ds_present === null  && r.dns_dnskey_present === false],
    ['DS=null,  DNSKEY=null  (both unknown)',           r => r.dns_ds_present === null  && r.dns_dnskey_present === null],
  ];
  for (const [label, pred] of groups) {
    const n = results.filter(pred).length;
    if (n > 0 || label.includes('properly') || label.includes('no DNSSEC')) {
      console.log(`    ${label.padEnd(52)}: ${String(n).padStart(4)}   ${pct(n, total)}`);
    }
  }

  if (dsPresent.length === 0) {
    console.log(`\n${HR}\n`);
    return;
  }

  // ── 4. DS algorithm distribution ─────────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 4. DS ALGORITHM DISTRIBUTION  (${dsPresent.length} domains with dns_ds_present = true)`);
  console.log();
  const algoCount = {};
  for (const r of dsPresent) {
    for (const a of r.ds_algorithms) { algoCount[a] = (algoCount[a] ?? 0) + 1; }
  }
  if (Object.keys(algoCount).length === 0) {
    console.log('    (none)');
  } else {
    for (const [alg, n] of Object.entries(algoCount).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`    algorithm ${String(alg).padEnd(4)}: ${String(n).padStart(4)}   ${pct(n, dsPresent.length)}`);
    }
  }

  // ── 5. DS digest type distribution ───────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 5. DS DIGEST TYPE DISTRIBUTION  (${dsPresent.length} domains with dns_ds_present = true)`);
  console.log();
  const digestCount = {};
  for (const r of dsPresent) {
    for (const d of r.ds_digest_types) { digestCount[d] = (digestCount[d] ?? 0) + 1; }
  }
  for (const [dt, n] of Object.entries(digestCount).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const label = { 1: 'SHA-1', 2: 'SHA-256', 3: 'GOST', 4: 'SHA-384' }[dt] ?? `type ${dt}`;
    console.log(`    digest_type ${String(dt).padEnd(2)} (${label.padEnd(8)}): ${String(n).padStart(4)}   ${pct(n, dsPresent.length)}`);
  }

  // ── 6. DS record count distribution ──────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 6. DS RECORD COUNT DISTRIBUTION  (${dsPresent.length} domains with dns_ds_present = true)`);
  console.log();
  const dsCounts = {};
  for (const r of dsPresent) { const k = r.ds_record_count; dsCounts[k] = (dsCounts[k] ?? 0) + 1; }
  for (const [k, n] of Object.entries(dsCounts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const note = Number(k) > 1 ? '  ← key rollover or multi-algorithm' : '';
    console.log(`    ds_record_count = ${String(k).padEnd(2)}: ${String(n).padStart(4)}   ${pct(n, dsPresent.length)}${note}`);
  }

  if (dkPresent.length === 0) {
    console.log(`\n${HR}\n`);
    return;
  }

  // ── 7. DNSKEY record count distribution ──────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 7. DNSKEY RECORD COUNT DISTRIBUTION  (${dkPresent.length} domains with dns_dnskey_present = true)`);
  console.log();
  const dkCounts = {};
  for (const r of dkPresent) { const k = r.dnskey_record_count; dkCounts[k] = (dkCounts[k] ?? 0) + 1; }
  for (const [k, n] of Object.entries(dkCounts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`    dnskey_record_count = ${String(k).padEnd(2)}: ${String(n).padStart(4)}   ${pct(n, dkPresent.length)}`);
  }

  // ── 8. KSK / ZSK distribution ────────────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 8. KSK / ZSK DISTRIBUTION  (${dkPresent.length} domains with dns_dnskey_present = true)`);
  console.log();
  const kskOnly  = dkPresent.filter(r => (r.dnskey_ksk_count ?? 0) > 0 && (r.dnskey_zsk_count ?? 0) === 0);
  const zskOnly  = dkPresent.filter(r => (r.dnskey_ksk_count ?? 0) === 0 && (r.dnskey_zsk_count ?? 0) > 0);
  const kskZsk   = dkPresent.filter(r => (r.dnskey_ksk_count ?? 0) > 0 && (r.dnskey_zsk_count ?? 0) > 0);
  const neither  = dkPresent.filter(r => (r.dnskey_ksk_count ?? 0) === 0 && (r.dnskey_zsk_count ?? 0) === 0);
  const withOther = dkPresent.filter(r => (r.dnskey_other_flags_count ?? 0) > 0);
  console.log(`    KSK only  (flags=257, no ZSK)         : ${String(kskOnly.length).padStart(4)}   ${pct(kskOnly.length, dkPresent.length)}`);
  console.log(`    ZSK only  (flags=256, no KSK)         : ${String(zskOnly.length).padStart(4)}   ${pct(zskOnly.length, dkPresent.length)}`);
  console.log(`    KSK + ZSK (both present)              : ${String(kskZsk.length).padStart(4)}   ${pct(kskZsk.length, dkPresent.length)}`);
  console.log(`    Neither   (no 256 or 257 flags)       : ${String(neither.length).padStart(4)}   ${pct(neither.length, dkPresent.length)}`);
  if (withOther.length > 0) {
    console.log(`    Non-standard flags present            : ${String(withOther.length).padStart(4)}   ${pct(withOther.length, dkPresent.length)}`);
  }

  // ── 9. DNSKEY algorithm distribution ─────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 9. DNSKEY ALGORITHM DISTRIBUTION  (${dkPresent.length} domains with dns_dnskey_present = true)`);
  console.log();
  const dkAlgoCount = {};
  for (const r of dkPresent) {
    for (const a of r.dnskey_algorithms) { dkAlgoCount[a] = (dkAlgoCount[a] ?? 0) + 1; }
  }
  for (const [alg, n] of Object.entries(dkAlgoCount).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`    algorithm ${String(alg).padEnd(4)}: ${String(n).padStart(4)}   ${pct(n, dkPresent.length)}`);
  }

  // ── 10. Evidence review ───────────────────────────────────────────────────

  console.log(`\n${HR}`);
  console.log(` EVIDENCE REVIEW — DNSSEC ADOPTERS`);
  console.log(`${HR}`);

  const adopters = results.filter(r => r.dns_ds_present === true && r._domain);
  const sample   = adopters.slice(0, 8);

  if (sample.length === 0) {
    console.log('\n  (no adopters to display)\n');
  } else {
    console.log(`\n  Showing ${sample.length} of ${adopters.length} adopter(s):\n`);
    for (const r of sample) {
      console.log(`  Domain               : ${r._domain}`);
      console.log(`  dns_ds_present       : ${r.dns_ds_present}`);
      console.log(`  dns_dnskey_present   : ${r.dns_dnskey_present}`);
      console.log(`  ds_record_count      : ${r.ds_record_count}`);
      console.log(`  ds_algorithms        : [${r.ds_algorithms.join(', ')}]`);
      console.log(`  ds_digest_types      : [${r.ds_digest_types.join(', ')}]`);
      console.log(`  ds_key_tags          : [${r.ds_key_tags.join(', ')}]`);
      console.log(`  dnskey_record_count  : ${r.dnskey_record_count}`);
      console.log(`  dnskey_ksk_count     : ${r.dnskey_ksk_count}`);
      console.log(`  dnskey_zsk_count     : ${r.dnskey_zsk_count}`);
      console.log(`  dnskey_algorithms    : [${r.dnskey_algorithms.join(', ')}]`);
      console.log(`  dnskey_key_tags      : [${r.dnskey_key_tags.join(', ')}]`);
      console.log();
    }
  }

  console.log(`${HR}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR        = '═'.repeat(72);
  const startedAt = new Date();

  console.log(`\n${HR}`);
  console.log(` SOT-DNSSEC-001 — HE-001 University Cohort DNSSEC Collection`);
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
  console.log(`  Supabase: signal_facts_dnssec ready`);

  const { error: tableErr } = await supabase.from('signal_facts_dnssec').select('id').limit(1);
  if (tableErr) throw new Error(`Cannot access signal_facts_dnssec: ${tableErr.message}\nApply migration 011_signal_lab_dnssec.sql first.`);

  console.log(`\n\n${HR}`);
  console.log(` Collecting — ${institutions.length} institutions  concurrency: ${CONCURRENCY}`);
  console.log(`${HR}\n`);
  console.log(`  Legend:  DS:Y present   DS:N absent   DS:? unknown\n`);

  const t0      = Date.now();
  const results = await runWithConcurrency(institutions, async ({ domain }, i) => {
    const r = await collectDnssec(domain);
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
