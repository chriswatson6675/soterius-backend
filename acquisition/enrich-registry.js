'use strict';

// enrich-registry.js — Phase 3: dedup registry by FRN, backfill SIC codes from CH.
//
// Step 1: Dedup — removes duplicate FRN entries (24 written by zombie Phase 2 process).
//   Keeps the FIRST occurrence of each FRN (earliest persistedAt).
//
// Step 2: SIC backfill — for each of the ~6,830 deduplicated firms, calls CH
//   GET /company/{companyNumber} to fetch sic_codes[], adds to registry record.
//   Pacing: 520ms floor via CH rate manager (600 req/5min budget).
//   Flush every 500 firms → safe to restart after a crash (skips records already
//   having a sicCodes field).
//
// Writes registry.ndjson in place. Atomic-ish: flushes incrementally then final write.
//
// Usage:
//   node enrich-registry.js [--registry <path>] [--limit N]

const path = require('node:path');
try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const chClient = require('../collection/sources/companies-house/ch-client');

const CH_PDA = 'https://api.company-information.service.gov.uk';
const print = (s) => fs.writeSync(1, s); // unbuffered write — avoids stdout buffering on Windows pipes

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }

async function main() {
  const runDir = path.join(__dirname, 'runs', 'fca');
  const registryPath = arg('--registry', path.join(runDir, 'registry.ndjson'));
  const limit = arg('--limit') ? parseInt(arg('--limit'), 10) : null;

  const chApiKey = process.env.CH_API_KEY || process.env.COMPANIES_HOUSE_API_KEY;
  if (!chApiKey) { console.error('CH_API_KEY or COMPANIES_HOUSE_API_KEY required'); process.exit(2); }

  // ── Step 1: Read + deduplicate ──────────────────────────────────────────────
  print('Phase 3 — Registry Enrichment\n');
  print('Step 1: deduplicating registry by FRN...\n');

  const raw = fs.readFileSync(registryPath, 'utf8').split('\n').filter(Boolean);
  print(`  read ${raw.length} lines\n`);

  const seen = new Set();
  const records = [];
  let dups = 0;
  for (const line of raw) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (seen.has(rec.frn)) { dups++; continue; }
    seen.add(rec.frn);
    records.push(rec);
  }
  print(`  deduplicated: ${records.length} unique firms (${dups} duplicates removed)\n\n`);

  // ── Step 2: SIC backfill ────────────────────────────────────────────────────
  print('Step 2: SIC backfill via CH API...\n');

  const alreadyEnriched = records.filter((r) => r.sicCodes !== undefined).length;
  if (alreadyEnriched > 0) print(`  resuming: ${alreadyEnriched} firms already enriched, skipping\n`);

  const rateManager = chClient.createRateManager();
  const counts = { enriched: 0, already_done: 0, no_number: 0, ch_failed: 0 };

  const target = limit ? Math.min(limit, records.length) : records.length;

  for (let i = 0; i < target; i++) {
    const rec = records[i];

    if ((i + 1) % 100 === 0) {
      const pct = (((i + 1) / target) * 100).toFixed(0);
      print(`[${i + 1}/${target} ${pct}%] enriched:${counts.enriched} ch_failed:${counts.ch_failed} no_number:${counts.no_number}\n`);
    }

    if (rec.sicCodes !== undefined) { counts.already_done++; continue; }

    if (!rec.companyNumber) {
      rec.sicCodes = null;
      counts.no_number++;
      continue;
    }

    const url = `${CH_PDA}/company/${encodeURIComponent(String(rec.companyNumber))}`;
    const r = await chClient.getJson(url, { apiKey: chApiKey, rateManager });

    if (r.errorType === 'NONE' && r.body) {
      rec.sicCodes = Array.isArray(r.body.sic_codes) ? r.body.sic_codes : [];
      counts.enriched++;
    } else {
      rec.sicCodes = null;
      counts.ch_failed++;
    }

    // Flush every 500 firms so a crash leaves at most 500 records to redo
    if ((i + 1) % 500 === 0) {
      fs.writeFileSync(registryPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
  }

  // Final write — always write all records so dedup is committed even if limit was used
  fs.writeFileSync(registryPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  print(
    [
      '',
      'Phase 3 Enrichment Summary',
      `  total firms      : ${records.length}`,
      `  SIC enriched     : ${counts.enriched}`,
      `  already enriched : ${counts.already_done}`,
      `  no CH number     : ${counts.no_number}`,
      `  CH failed        : ${counts.ch_failed}`,
      `  registry         : ${registryPath}`,
      '',
    ].join('\n') + '\n',
  );
}

main().catch((e) => { console.error('enrich-registry failed:', e.message); process.exit(1); });
