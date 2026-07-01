'use strict';

// SOT-SECURITYTXT-001 — HE-001 Pilot Run (first 10 domains)
//
// Console-only dry run — no database writes.
// Validates the collector against real university domains before
// running the full cohort or creating the Supabase migration.
//
// Usage:
//   node backend/signal-lab/signals/securitytxt/run-test-10.js

const fs   = require('node:fs');
const path = require('node:path');
const { collectSecurityTxt } = require('./securitytxt-collector');

const CSV_PATH         = path.join(__dirname, '../../../data/uk-learning-providers-20260615.csv');
const PILOT_SIZE       = 10;
const CONCURRENCY      = 5;
const COLLECTOR_VER    = '1.0.0-pilot';

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

function loadFirstN(n) {
  const text     = fs.readFileSync(CSV_PATH, 'utf8');
  const lines    = text.split('\n').filter(l => l.trim());
  const [header, ...rows] = lines;

  const headers    = splitCsvLine(header).map(h => h.trim().toLowerCase());
  const nameIdx    = headers.findIndex(h => h === 'provider_name' || h.includes('name'));
  const websiteIdx = headers.findIndex(h => h.includes('website'));

  const institutions = [];

  for (const row of rows) {
    if (institutions.length >= n) break;
    const cols    = splitCsvLine(row);
    const name    = cols[nameIdx]?.trim()    ?? '';
    const website = cols[websiteIdx]?.trim() ?? '';

    let domain = null;
    try {
      if (website && (website.startsWith('http://') || website.startsWith('https://'))) {
        domain = new URL(website).hostname.replace(/^www\./i, '').toLowerCase();
      }
    } catch {}

    if (!domain) continue;
    institutions.push({ name, domain });
  }

  return institutions;
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

function progressLine(record, domain, i, total) {
  const pct = String(Math.round(((i + 1) / total) * 100)).padStart(3);
  const fs  = record.file_state;

  const stateLabel = {
    PRESENT_CANONICAL:  'CANONICAL',
    PRESENT_LEGACY_ONLY:'LEGACY   ',
    PRESENT_BOTH:       'BOTH     ',
    ABSENT:             'ABSENT   ',
    INDETERMINATE:      'INDETERM.',
  }[fs] ?? fs.padEnd(9);

  const parse = record.canonical_parse ?? record.legacy_parse;
  let extra = '';
  if (parse) {
    extra += `  [${parse.content_state}]`;
    if (parse.directive_count > 0) extra += `  dirs=${parse.directive_count}`;
    if (parse.contact.length > 0)  extra += `  Contact=${parse.contact.length}`;
    if (parse.expires.length > 0)  extra += `  Expires=${parse.expires.length}`;
  } else {
    const cf = record.canonical_fetch;
    const lf = record.legacy_fetch;
    if (cf.fetch_state !== 'NOT_FOUND' && cf.fetch_state !== 'FOUND_EMPTY') {
      extra += `  canonical:${cf.fetch_state}`;
    }
    if (lf.fetch_state !== 'NOT_FOUND' && lf.fetch_state !== 'FOUND_EMPTY') {
      extra += `  legacy:${lf.fetch_state}`;
    }
  }

  return `  [${pct}%]  ${domain.padEnd(38)} ${stateLabel}${extra}`;
}

// ── Summary ───────────────────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? '  0.0%' : `${(n / total * 100).toFixed(1).padStart(5)}%`;
}

function printSummary(rows, startedAt) {
  const total = rows.length;
  const DIV   = '─'.repeat(72);
  const HR    = '═'.repeat(72);

  const byFileState = {};
  for (const r of rows) {
    byFileState[r.record.file_state] = (byFileState[r.record.file_state] ?? 0) + 1;
  }

  const present = rows.filter(r =>
    r.record.file_state === 'PRESENT_CANONICAL' ||
    r.record.file_state === 'PRESENT_LEGACY_ONLY' ||
    r.record.file_state === 'PRESENT_BOTH',
  );

  console.log(`\n${HR}`);
  console.log(` SOT-SECURITYTXT-001 — HE-001 PILOT SUMMARY (n=${total})`);
  console.log(` Collected: ${startedAt.toISOString()}`);
  console.log(HR);

  // 1. File state distribution
  console.log(`\n${DIV}`);
  console.log(` 1. FILE STATE DISTRIBUTION`);
  console.log();
  const stateOrder = ['PRESENT_BOTH', 'PRESENT_CANONICAL', 'PRESENT_LEGACY_ONLY', 'ABSENT', 'INDETERMINATE'];
  for (const state of stateOrder) {
    const n = byFileState[state] ?? 0;
    if (n > 0 || state === 'ABSENT') {
      console.log(`    ${state.padEnd(22)}: ${String(n).padStart(3)}   ${pct(n, total)}`);
    }
  }

  if (present.length === 0) {
    console.log(`\n${HR}\n`);
    return;
  }

  // 2. Content state distribution (canonical_parse preferred; legacy_parse fallback)
  console.log(`\n${DIV}`);
  console.log(` 2. CONTENT STATE DISTRIBUTION  (${present.length} domains with a file present)`);
  console.log();
  const byContentState = {};
  for (const { record } of present) {
    const parse = record.canonical_parse ?? record.legacy_parse;
    const cs = parse?.content_state ?? 'PARSE_NULL';
    byContentState[cs] = (byContentState[cs] ?? 0) + 1;
  }
  for (const [cs, n] of Object.entries(byContentState).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cs.padEnd(16)}: ${String(n).padStart(3)}   ${pct(n, present.length)}`);
  }

  // 3. RFC 9116 field presence
  console.log(`\n${DIV}`);
  console.log(` 3. RFC 9116 FIELD PRESENCE  (${present.length} domains with a file present)`);
  console.log();
  const fields = ['contact', 'expires', 'encryption', 'acknowledgments', 'policy', 'preferred_languages', 'hiring', 'canonical'];
  for (const field of fields) {
    const n = present.filter(({ record }) => {
      const p = record.canonical_parse ?? record.legacy_parse;
      return p && p[field] && p[field].length > 0;
    }).length;
    if (n > 0) {
      console.log(`    ${field.padEnd(22)}: ${String(n).padStart(3)}   ${pct(n, present.length)}`);
    }
  }

  // 4. Evidence review
  console.log(`\n${HR}`);
  console.log(` EVIDENCE REVIEW — PRESENT FILES`);
  console.log(HR);
  for (const { domain, record } of present) {
    const parse = record.canonical_parse ?? record.legacy_parse;
    console.log(`\n  Domain      : ${domain}`);
    console.log(`  file_state  : ${record.file_state}`);
    if (parse) {
      console.log(`  content     : ${parse.content_state}   dirs=${parse.directive_count}  total_lines=${parse.total_lines}`);
      if (parse.contact.length)             console.log(`  Contact     : ${parse.contact.map(v => v.trim()).join(' | ')}`);
      if (parse.expires.length)             console.log(`  Expires     : ${parse.expires.map(v => v.trim()).join(' | ')}`);
      if (parse.encryption.length)          console.log(`  Encryption  : ${parse.encryption.map(v => v.trim()).join(' | ')}`);
      if (parse.policy.length)              console.log(`  Policy      : ${parse.policy.map(v => v.trim()).join(' | ')}`);
      if (parse.acknowledgments.length)     console.log(`  Acks        : ${parse.acknowledgments.map(v => v.trim()).join(' | ')}`);
      if (parse.preferred_languages.length) console.log(`  Pref-Langs  : ${parse.preferred_languages.map(v => v.trim()).join(' | ')}`);
      if (parse.unknown_field_count > 0)    console.log(`  Unknown flds: ${parse.unknown_fields.map(f => f.field_name_raw).join(', ')}`);
      if (parse.malformed_line_count > 0)   console.log(`  Malformed   : ${parse.malformed_line_count} line(s)`);
    }
  }

  console.log(`\n${HR}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR        = '═'.repeat(72);
  const startedAt = new Date();

  console.log(`\n${HR}`);
  console.log(` SOT-SECURITYTXT-001 — HE-001 Pilot (first ${PILOT_SIZE} domains)`);
  console.log(` Console-only — no database writes`);
  console.log(` Started: ${startedAt.toISOString()}`);
  console.log(HR);

  const institutions = loadFirstN(PILOT_SIZE);
  console.log(`\n  Loaded ${institutions.length} institutions from CSV\n`);

  console.log(`${HR}`);
  console.log(` Collecting — concurrency: ${CONCURRENCY}`);
  console.log(`${HR}\n`);

  const t0   = Date.now();
  const rows = await runWithConcurrency(institutions, async ({ name, domain }, i) => {
    const record = await collectSecurityTxt(domain, COLLECTOR_VER);
    console.log(progressLine(record, domain, i, institutions.length));
    return { name, domain, record };
  }, CONCURRENCY);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  Completed: ${institutions.length} institutions in ${elapsed}s`);

  printSummary(rows, startedAt);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
