'use strict';
/**
 * Prospect Acquisition — Companies House POC
 *
 * Fetches active solicitor firms (SIC 6910) from Companies House,
 * discovers their websites via Google Custom Search, and feeds them
 * into the existing import.js pipeline.
 *
 * Usage:
 *   node scripts/pipeline/acquire/acquire.js --location "Wales" [--limit 100] [--dry-run]
 *
 * Required env vars:
 *   COMPANIES_HOUSE_API_KEY   — from developer.company-information.service.gov.uk
 *   GOOGLE_SEARCH_API_KEY     — Google Cloud API key (Custom Search JSON API enabled)
 *   GOOGLE_SEARCH_CX          — Programmable Search Engine ID
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY  — already configured
 *
 * Outputs:
 *   - Per-firm discovery log
 *   - Acquisition metrics (discovery rate, confidence breakdown, review rate)
 *   - POC readiness verdict (Green / Amber / Red)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { log, warn, error }  = require('../lib/log');
const { fetchSolicitors }   = require('./sources/companies-house');
const { discoverWebsites }  = require('./discover');
const importModule           = require('../import');

// ── CSV serialiser ────────────────────────────────────────────────────────────
// Must match the column names import.js accepts.

const CSV_COLUMNS = [
  'firm_name', 'website', 'sector', 'location', 'source', 'source_date',
  'source_reference', 'firm_confidence', 'domain_confidence', 'postcode', 'notes',
];

function escapeCSV(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function recordsToCsv(records) {
  const header = CSV_COLUMNS.join(',');
  const rows   = records.map(r => CSV_COLUMNS.map(col => escapeCSV(r[col])).join(','));
  return [header, ...rows].join('\n');
}

// ── Annotations for low-confidence records ────────────────────────────────────

function annotate(records) {
  for (const r of records) {
    if (r.domain_confidence > 0 && r.domain_confidence < 70) {
      r.notes = `UNCERTAIN_WEBSITE: discovery_confidence=${r.domain_confidence} — verify domain before scanning`;
    }
  }
}

// ── Metrics printer ───────────────────────────────────────────────────────────

function printMetrics(chCount, discoverStats, importStats, dryRun) {
  const pct = (n, d) => d > 0 ? `${Math.round((n / d) * 100)}%` : '—';

  const discoveryRate = pct(discoverStats.discovered, chCount);
  const highConfRate  = pct(discoverStats.highConf, discoverStats.discovered);
  const reviewRate    = pct(discoverStats.reviewRequired, chCount);

  console.log(`\n${'═'.repeat(62)}`);
  console.log(` ACQUISITION METRICS — COMPANIES HOUSE POC`);
  console.log(`${'═'.repeat(62)}`);

  console.log(`\n── Source ──────────────────────────────────────────────────`);
  console.log(`   Records from Companies House:      ${String(chCount).padStart(4)}`);

  console.log(`\n── Website Discovery ───────────────────────────────────────`);
  console.log(`   Website discovered:                ${String(discoverStats.discovered).padStart(4)}  (${discoveryRate})`);
  console.log(`   ├─ High confidence  (≥70):         ${String(discoverStats.highConf).padStart(4)}  (${highConfRate} of discovered)`);
  console.log(`   ├─ Medium confidence (50–69):      ${String(discoverStats.medConf).padStart(4)}`);
  console.log(`   ├─ Low confidence   (35–49):       ${String(discoverStats.lowConf).padStart(4)}`);
  console.log(`   └─ No website found:               ${String(discoverStats.noMatch).padStart(4)}`);

  console.log(`\n── Pipeline Feed ───────────────────────────────────────────`);
  if (dryRun) {
    console.log(`   [dry-run] Would import:            ${String(discoverStats.discovered).padStart(4)}`);
  } else if (importStats) {
    console.log(`   Inserted to pipeline:              ${String(importStats.inserted).padStart(4)}`);
    console.log(`   Already existed (skipped):         ${String(importStats.skipped).padStart(4)}`);
    console.log(`   Import errors:                     ${String(importStats.errors).padStart(4)}`);
  }

  console.log(`\n── POC Metrics ─────────────────────────────────────────────`);
  console.log(`   Website discovery rate:            ${discoveryRate}`);
  console.log(`   High confidence discovery rate:    ${highConfRate}`);
  console.log(`   Manual review required:            ${reviewRate}`);

  // Green/Amber/Red verdict
  const discRate = chCount > 0 ? discoverStats.discovered / chCount : 0;
  const hcRate   = discoverStats.discovered > 0 ? discoverStats.highConf / discoverStats.discovered : 0;
  const rvRate   = chCount > 0 ? discoverStats.reviewRequired / chCount : 1;

  let verdict;
  if (discRate >= 0.70 && hcRate >= 0.70 && rvRate <= 0.20) {
    verdict = 'GREEN  — acquisition pipeline is scalable';
  } else if (discRate >= 0.50 && hcRate >= 0.50) {
    verdict = 'AMBER  — acceptable for initial collection; review discovery gaps before scaling';
  } else {
    verdict = 'RED    — discovery quality insufficient; investigate before scaling';
  }

  console.log(`\n   Verdict: ${verdict}`);
  console.log(`\n── Next Step ───────────────────────────────────────────────`);

  if (rvRate > 0.20) {
    console.log(`   Review uncertain websites: node scripts/pipeline/review.js`);
  }
  if (discRate >= 0.50) {
    console.log(`   Run validation:           node scripts/pipeline/validate.js`);
  }
  if (!dryRun && importStats?.inserted > 0) {
    console.log(`   View pipeline status:     node scripts/pipeline/status.js`);
  }

  console.log(`${'═'.repeat(62)}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run({ location, limit = 100, dryRun = false } = {}) {
  if (!location) throw new Error('--location is required (e.g. "Wales", "Bangor", "North Wales")');

  log(`Acquisition POC — source: companies-house | location: "${location}" | limit: ${limit}${dryRun ? ' | dry-run' : ''}`);

  // ── Stage 1: Fetch from Companies House ──────────────────────────────────────

  log('Stage 1/3 — Fetching firms from Companies House...');
  const records = await fetchSolicitors({ location, limit });

  if (!records.length) {
    warn('No records returned from Companies House. Verify COMPANIES_HOUSE_API_KEY and --location value.');
    return;
  }
  log(`Stage 1 complete — ${records.length} firms fetched`);

  // ── Stage 2: Website discovery ────────────────────────────────────────────────

  log('Stage 2/3 — Discovering websites via Google Search...');
  const discoverStats = await discoverWebsites(records);
  log(`Stage 2 complete — websites found for ${discoverStats.discovered}/${records.length} firms`);

  // ── Stage 3: Import to pipeline ───────────────────────────────────────────────

  const withWebsite = records.filter(r => r.website);

  if (!withWebsite.length) {
    warn('Stage 3 skipped — no websites discovered. Check GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX.');
    printMetrics(records.length, discoverStats, null, dryRun);
    return;
  }

  // Annotate low-confidence records so they surface in review queue
  annotate(withWebsite);

  let importStats = null;

  if (dryRun) {
    log('Stage 3/3 — [dry-run] Skipping import. Records that would be imported:');
    for (const r of withWebsite) {
      log(`  [dry-run] ${r.firm_name} → ${r.website} (confidence: ${r.domain_confidence})`);
    }
    importStats = { inserted: 0, skipped: 0, flagged: 0, errors: 0 };
  } else {
    log(`Stage 3/3 — Importing ${withWebsite.length} records into pipeline...`);
    const tempFile = path.join(os.tmpdir(), `soterius-acquire-${Date.now()}.csv`);
    try {
      fs.writeFileSync(tempFile, recordsToCsv(withWebsite), 'utf8');
      importStats = await importModule.run({ file: tempFile, dryRun: false });
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  }

  printMetrics(records.length, discoverStats, importStats, dryRun);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  const locationIdx = args.indexOf('--location');
  const limitIdx    = args.indexOf('--limit');

  const location = locationIdx !== -1 ? args[locationIdx + 1] : null;
  const limit    = limitIdx    !== -1 ? parseInt(args[limitIdx + 1], 10) : 100;
  const dryRun   = args.includes('--dry-run');

  run({ location, limit, dryRun }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
