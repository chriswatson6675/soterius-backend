'use strict';

// SOT-CAA-001 — HE-001 University Cohort CAA Collection Run
//
// Reads the HE-001 cohort from the data.ac.uk CSV,
// runs the CAA collector against every domain,
// stores all observations in signal_facts_caa,
// and prints a full cohort analysis.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/caa/run-he-001.js
//
// Prerequisites:
//   Migration 012_signal_lab_caa.sql applied in Supabase Dashboard.

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const fs   = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { collectCaa, SIGNAL_ID, SIGNAL_VERSION } = require('./caa-collector');

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
  const p   = r.dns_caa_present;

  const status = p === true  ? 'CAA:Y' :
                 p === false ? 'CAA:N' :
                 `CAA:?(${r.caa_collection_error ?? '?'})`;

  let extra = '';
  if (p === true) {
    if (r.caa_issue_count > 0)     extra += `  iss=${r.caa_issue_count}`;
    if (r.caa_issuewild_count > 0) extra += `  wild=${r.caa_issuewild_count}`;
    if (r.caa_iodef_count > 0)     extra += `  iodef=${r.caa_iodef_count}`;
    if (r.caa_critical_count > 0)  extra += `  crit=${r.caa_critical_count}`;
    if (r.caa_unknown_tag_count > 0) extra += `  unk=${r.caa_unknown_tag_count}`;
  }

  return `  [${pct}%]  ${domain.padEnd(42)} ${status}${extra}`;
}

// ── Supabase insert ───────────────────────────────────────────────────────────

async function insertRecord(supabase, domain, r) {
  const { error } = await supabase.from('signal_facts_caa').insert({
    domain,
    signal_version:        SIGNAL_VERSION,
    collected_at:          new Date().toISOString(),
    dns_caa_present:       r.dns_caa_present,
    caa_collection_error:  r.caa_collection_error,
    caa_records:           r.caa_records,
    caa_record_count:      r.caa_record_count,
    caa_issue_count:       r.caa_issue_count,
    caa_issuewild_count:   r.caa_issuewild_count,
    caa_iodef_count:       r.caa_iodef_count,
    caa_unknown_tag_count: r.caa_unknown_tag_count,
    caa_critical_count:    r.caa_critical_count,
    caa_issue_values:      r.caa_issue_values,
    caa_issuewild_values:  r.caa_issuewild_values,
    caa_iodef_values:      r.caa_iodef_values,
    caa_tags_present:      r.caa_tags_present,
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

  const present = results.filter(r => r.dns_caa_present === true);
  const absent  = results.filter(r => r.dns_caa_present === false);
  const unknown = results.filter(r => r.dns_caa_present === null);

  console.log(`\n${HR}`);
  console.log(` SOT-CAA-001 — HE-001 COHORT SUMMARY`);
  console.log(` Signal: ${SIGNAL_ID} v${SIGNAL_VERSION}   Cohort: ${COHORT_CODE}   n = ${total}`);
  console.log(` Collected: ${startedAt.toISOString()}`);
  console.log(HR);

  // ── 1. CAA presence distribution ──────────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 1. CAA PRESENCE DISTRIBUTION`);
  console.log();
  console.log(`    dns_caa_present = true  : ${String(present.length).padStart(4)}   ${pct(present.length, total)}`);
  console.log(`    dns_caa_present = false : ${String(absent.length).padStart(4)}   ${pct(absent.length, total)}`);
  console.log(`    dns_caa_present = null  : ${String(unknown.length).padStart(4)}   ${pct(unknown.length, total)}`);

  if (unknown.length > 0) {
    console.log();
    console.log(`    Collection error breakdown:`);
    const errs = {};
    for (const r of unknown) { const k = r.caa_collection_error ?? 'null'; errs[k] = (errs[k] ?? 0) + 1; }
    for (const [k, n] of Object.entries(errs)) console.log(`      ${k.padEnd(20)}: ${n}`);
  }

  if (present.length === 0) {
    console.log(`\n${HR}\n`);
    return;
  }

  // ── 2. Tag type distribution ──────────────────────────────────────────────

  const hasIssue     = present.filter(r => r.caa_issue_count > 0);
  const hasIssuewild = present.filter(r => r.caa_issuewild_count > 0);
  const hasIodef     = present.filter(r => r.caa_iodef_count > 0);
  const hasCritical  = present.filter(r => r.caa_critical_count > 0);
  const hasUnknown   = present.filter(r => r.caa_unknown_tag_count > 0);

  console.log(`\n${DIV}`);
  console.log(` 2. TAG TYPE DISTRIBUTION  (${present.length} domains with dns_caa_present = true)`);
  console.log();
  console.log(`    has issue tag          : ${String(hasIssue.length).padStart(4)}   ${pct(hasIssue.length, present.length)}`);
  console.log(`    has issuewild tag      : ${String(hasIssuewild.length).padStart(4)}   ${pct(hasIssuewild.length, present.length)}`);
  console.log(`    has iodef tag          : ${String(hasIodef.length).padStart(4)}   ${pct(hasIodef.length, present.length)}`);
  console.log(`    has critical flag      : ${String(hasCritical.length).padStart(4)}   ${pct(hasCritical.length, present.length)}`);
  console.log(`    has unknown tags       : ${String(hasUnknown.length).padStart(4)}   ${pct(hasUnknown.length, present.length)}`);

  // ── 3. Tag combination distribution ──────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 3. TAG COMBINATION DISTRIBUTION  (${present.length} domains with dns_caa_present = true)`);
  console.log();

  const combinations = [
    ['issue only (no issuewild, no iodef)',     r => r.caa_issue_count > 0 && r.caa_issuewild_count === 0 && r.caa_iodef_count === 0],
    ['issue + iodef (no issuewild)',            r => r.caa_issue_count > 0 && r.caa_issuewild_count === 0 && r.caa_iodef_count > 0],
    ['issue + issuewild (no iodef)',            r => r.caa_issue_count > 0 && r.caa_issuewild_count > 0  && r.caa_iodef_count === 0],
    ['issue + issuewild + iodef (full policy)', r => r.caa_issue_count > 0 && r.caa_issuewild_count > 0  && r.caa_iodef_count > 0],
    ['issuewild only (no issue)',               r => r.caa_issue_count === 0 && r.caa_issuewild_count > 0],
    ['iodef only (no issue or issuewild)',      r => r.caa_issue_count === 0 && r.caa_issuewild_count === 0 && r.caa_iodef_count > 0],
    ['unknown tags only',                       r => r.caa_issue_count === 0 && r.caa_issuewild_count === 0 && r.caa_iodef_count === 0 && r.caa_unknown_tag_count > 0],
  ];

  for (const [label, pred] of combinations) {
    const n = present.filter(pred).length;
    if (n > 0) {
      console.log(`    ${label.padEnd(48)}: ${String(n).padStart(4)}   ${pct(n, present.length)}`);
    }
  }

  // ── 4. Record count distribution ─────────────────────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 4. RECORD COUNT DISTRIBUTION  (${present.length} domains with dns_caa_present = true)`);
  console.log();
  const recCounts = {};
  for (const r of present) { const k = r.caa_record_count; recCounts[k] = (recCounts[k] ?? 0) + 1; }
  for (const [k, n] of Object.entries(recCounts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`    caa_record_count = ${String(k).padEnd(2)}: ${String(n).padStart(4)}   ${pct(n, present.length)}`);
  }

  // ── 5. Critical flag distribution ────────────────────────────────────────

  const critZero  = present.filter(r => r.caa_critical_count === 0);
  const critSome  = present.filter(r => r.caa_critical_count > 0);

  console.log(`\n${DIV}`);
  console.log(` 5. CRITICAL FLAG DISTRIBUTION  (${present.length} domains with dns_caa_present = true)`);
  console.log();
  console.log(`    no critical records (caa_critical_count = 0) : ${String(critZero.length).padStart(4)}   ${pct(critZero.length, present.length)}`);
  console.log(`    has critical records (caa_critical_count > 0): ${String(critSome.length).padStart(4)}   ${pct(critSome.length, present.length)}`);

  // ── 6. CA identifier distribution (issue values) ──────────────────────────

  console.log(`\n${DIV}`);
  console.log(` 6. AUTHORISED CA DISTRIBUTION  (from caa_issue_values — ${hasIssue.length} domains with issue records)`);
  console.log();
  const caCounts = {};
  for (const r of hasIssue) {
    for (const v of r.caa_issue_values) {
      // Extract CA identifier before any ';' parameter separator
      const ca = v.split(';')[0].trim().toLowerCase() || '(empty)';
      caCounts[ca] = (caCounts[ca] ?? 0) + 1;
    }
  }
  const sortedCas = Object.entries(caCounts).sort((a, b) => b[1] - a[1]);
  for (const [ca, n] of sortedCas.slice(0, 15)) {
    console.log(`    ${ca.padEnd(40)}: ${String(n).padStart(4)}   ${pct(n, hasIssue.length)}`);
  }
  if (sortedCas.length > 15) {
    console.log(`    ... and ${sortedCas.length - 15} more CA identifiers`);
  }

  // ── 7. Iodef URI scheme distribution ─────────────────────────────────────

  if (hasIodef.length > 0) {
    console.log(`\n${DIV}`);
    console.log(` 7. IODEF URI SCHEME DISTRIBUTION  (${hasIodef.length} domains with iodef records)`);
    console.log();
    let mailtoCount = 0, httpsCount = 0, httpCount = 0, otherCount = 0;
    for (const r of hasIodef) {
      for (const v of r.caa_iodef_values) {
        if (v.startsWith('mailto:'))  mailtoCount++;
        else if (v.startsWith('https:')) httpsCount++;
        else if (v.startsWith('http:'))  httpCount++;
        else                             otherCount++;
      }
    }
    if (mailtoCount > 0) console.log(`    mailto:  : ${String(mailtoCount).padStart(4)}   ${pct(mailtoCount, hasIodef.length)}`);
    if (httpsCount > 0)  console.log(`    https:   : ${String(httpsCount).padStart(4)}  ${pct(httpsCount, hasIodef.length)}`);
    if (httpCount > 0)   console.log(`    http:    : ${String(httpCount).padStart(4)}   ${pct(httpCount, hasIodef.length)}`);
    if (otherCount > 0)  console.log(`    other    : ${String(otherCount).padStart(4)}   ${pct(otherCount, hasIodef.length)}`);
  }

  // ── 8. Unknown tag names ──────────────────────────────────────────────────

  if (hasUnknown.length > 0) {
    console.log(`\n${DIV}`);
    console.log(` 8. UNKNOWN TAG NAMES  (${hasUnknown.length} domains with unknown tags)`);
    console.log();
    const unknownTagNames = {};
    for (const r of hasUnknown) {
      for (const rec of r.caa_records) {
        if (!['issue', 'issuewild', 'iodef'].includes(rec.tag) && rec.tag) {
          unknownTagNames[rec.tag] = (unknownTagNames[rec.tag] ?? 0) + 1;
        }
      }
    }
    for (const [tag, n] of Object.entries(unknownTagNames).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${tag.padEnd(30)}: ${String(n).padStart(4)}`);
    }
  }

  // ── 9. Evidence review — adopters ─────────────────────────────────────────

  console.log(`\n${HR}`);
  console.log(` EVIDENCE REVIEW — CAA ADOPTERS`);
  console.log(HR);

  const adopters = results.filter(r => r.dns_caa_present === true && r._domain);
  const sample   = adopters.slice(0, 8);

  if (sample.length === 0) {
    console.log('\n  (no adopters to display)\n');
  } else {
    console.log(`\n  Showing ${sample.length} of ${adopters.length} adopter(s):\n`);
    for (const r of sample) {
      console.log(`  Domain               : ${r._domain}`);
      console.log(`  caa_record_count     : ${r.caa_record_count}`);
      console.log(`  caa_issue_count      : ${r.caa_issue_count}`);
      console.log(`  caa_issuewild_count  : ${r.caa_issuewild_count}`);
      console.log(`  caa_iodef_count      : ${r.caa_iodef_count}`);
      console.log(`  caa_critical_count   : ${r.caa_critical_count}`);
      console.log(`  caa_tags_present     : [${r.caa_tags_present.join(', ')}]`);
      if (r.caa_issue_values.length > 0)     console.log(`  caa_issue_values     : ${JSON.stringify(r.caa_issue_values)}`);
      if (r.caa_issuewild_values.length > 0) console.log(`  caa_issuewild_values : ${JSON.stringify(r.caa_issuewild_values)}`);
      if (r.caa_iodef_values.length > 0)     console.log(`  caa_iodef_values     : ${JSON.stringify(r.caa_iodef_values)}`);
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
  console.log(` SOT-CAA-001 — HE-001 University Cohort CAA Collection`);
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
  console.log(`  Supabase: signal_facts_caa ready`);

  const { error: tableErr } = await supabase.from('signal_facts_caa').select('id').limit(1);
  if (tableErr) throw new Error(`Cannot access signal_facts_caa: ${tableErr.message}\nApply migration 012_signal_lab_caa.sql first.`);

  console.log(`\n\n${HR}`);
  console.log(` Collecting — ${institutions.length} institutions  concurrency: ${CONCURRENCY}`);
  console.log(`${HR}\n`);
  console.log(`  Legend:  CAA:Y present   CAA:N absent   CAA:? unknown\n`);

  const t0      = Date.now();
  const results = await runWithConcurrency(institutions, async ({ domain }, i) => {
    const r = await collectCaa(domain);
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
