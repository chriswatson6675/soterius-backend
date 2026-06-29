'use strict';
/**
 * Pipeline Status Dashboard
 *
 * Prints a current snapshot of the research pipeline:
 *   - Prospect counts by pipeline_status
 *   - Sector breakdown
 *   - Source attribution (records per source, avg confidence per source)
 *   - Confidence scores (averages, low-confidence count)
 *   - Low-confidence records detail (<80 on either metric)
 *   - Postcode coverage (sources, avg confidence, low-confidence postcodes)
 *   - Active flags summary
 *   - Rescan outlook
 *
 * Usage:
 *   node scripts/pipeline/status.js [--low-confidence-detail] [--postcode-detail]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { getAllProspects } = require('./lib/db');
const { error }           = require('./lib/log');

const STATUS_ORDER = [
  'new',
  'pending_validate',
  'valid',
  'pending_scan',
  'scan_complete',
  'scan_due',
  'scan_failed',
  'flagged',
  'invalid',
  'excluded',
];

const LOW_CONFIDENCE_THRESHOLD = 80;

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
}

const POSTCODE_CONFIDENCE_THRESHOLD = 80;

const POSTCODE_SOURCE_ORDER = ['register_api', 'csv', 'schema_org', 'microdata', 'regex', 'manual'];

async function run({ showLowDetail = false, showPostcodeDetail = false } = {}) {
  const all = await getAllProspects();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(` SOTERIUS RESEARCH PIPELINE — STATUS`);
  console.log(`${'═'.repeat(60)}`);
  console.log(` Total prospects: ${all.length}`);
  console.log(` As of: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);

  // ── Pipeline status distribution ─────────────────────────────────────────────
  const byStatus = {};
  for (const s of STATUS_ORDER) byStatus[s] = 0;
  for (const p of all) {
    const s = p.pipeline_status || 'new';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  console.log(`\n── Pipeline Status ───────────────────────────────────────`);
  for (const s of STATUS_ORDER) {
    if (byStatus[s] > 0) {
      console.log(`   ${s.padEnd(22)} ${String(byStatus[s]).padStart(4)}`);
    }
  }

  // ── Sector breakdown ─────────────────────────────────────────────────────────
  const bySector = {};
  for (const p of all) {
    const s = p.sector || '(not set)';
    bySector[s] = (bySector[s] || 0) + 1;
  }
  const sectors = Object.entries(bySector).sort((a, b) => b[1] - a[1]);

  console.log(`\n── Sector Breakdown ──────────────────────────────────────`);
  for (const [sector, count] of sectors) {
    console.log(`   ${sector.padEnd(22)} ${String(count).padStart(4)}`);
  }

  // ── Source attribution ────────────────────────────────────────────────────────
  const sourceMap = {};
  for (const p of all) {
    const src = p.source || '(not set)';
    if (!sourceMap[src]) sourceMap[src] = { count: 0, firmConfs: [], domainConfs: [] };
    sourceMap[src].count++;
    if (typeof p.firm_confidence   === 'number') sourceMap[src].firmConfs.push(p.firm_confidence);
    if (typeof p.domain_confidence === 'number') sourceMap[src].domainConfs.push(p.domain_confidence);
  }
  const sources = Object.entries(sourceMap).sort((a, b) => b[1].count - a[1].count);

  console.log(`\n── Source Attribution ────────────────────────────────────`);
  console.log(`   ${'Source'.padEnd(26)} ${'Count'.padStart(5)}  ${'Firm'.padStart(5)}  ${'Domain'.padStart(6)}`);
  console.log(`   ${'─'.repeat(26)} ${'─'.repeat(5)}  ${'─'.repeat(5)}  ${'─'.repeat(6)}`);
  for (const [src, data] of sources) {
    const fc = avg(data.firmConfs);
    const dc = avg(data.domainConfs);
    console.log(
      `   ${src.padEnd(26)} ${String(data.count).padStart(5)}  ` +
      `${fc !== null ? String(fc).padStart(5) : '   —'.padStart(5)}  ` +
      `${dc !== null ? String(dc).padStart(6) : '    —'.padStart(6)}`
    );
  }
  console.log(`   (Firm/Domain columns show avg confidence score)`);

  // ── Confidence scores ─────────────────────────────────────────────────────────
  const firmConfs   = all.map(p => p.firm_confidence).filter(v => typeof v === 'number');
  const domainConfs = all.map(p => p.domain_confidence).filter(v => typeof v === 'number');

  const lowFirm   = all.filter(p => typeof p.firm_confidence   === 'number' && p.firm_confidence   < LOW_CONFIDENCE_THRESHOLD);
  const lowDomain = all.filter(p => typeof p.domain_confidence === 'number' && p.domain_confidence < LOW_CONFIDENCE_THRESHOLD);
  const lowAny    = [...new Map([...lowFirm, ...lowDomain].map(p => [p.id, p])).values()];

  console.log(`\n── Confidence Scores ─────────────────────────────────────`);
  console.log(`   Avg firm confidence:          ${avg(firmConfs) ?? '—'}`);
  console.log(`   Avg domain confidence:        ${avg(domainConfs) ?? '—'}`);
  console.log(`   Low-confidence records (<${LOW_CONFIDENCE_THRESHOLD}): ${lowAny.length}`);

  if (lowAny.length > 0) {
    if (showLowDetail) {
      console.log(`\n── Low-Confidence Records (<${LOW_CONFIDENCE_THRESHOLD}) ──────────────────────`);
      console.log(`   ${'Domain'.padEnd(32)} ${'Firm'.padStart(5)}  ${'Domain'.padStart(6)}  Flags`);
      console.log(`   ${'─'.repeat(32)} ${'─'.repeat(5)}  ${'─'.repeat(6)}  ${'─'.repeat(20)}`);
      for (const p of lowAny.sort((a, b) => (a.domain_confidence ?? 999) - (b.domain_confidence ?? 999))) {
        const flagCodes = Array.isArray(p.pipeline_flags) && p.pipeline_flags.length
          ? p.pipeline_flags.map(f => f.code).join(', ')
          : '';
        console.log(
          `   ${p.website.padEnd(32)} ` +
          `${String(p.firm_confidence ?? '—').padStart(5)}  ` +
          `${String(p.domain_confidence ?? '—').padStart(6)}  ` +
          flagCodes
        );
      }
    } else {
      console.log(`   Run with --low-confidence-detail to list records`);
    }
  }

  // ── Postcode coverage ─────────────────────────────────────────────────────────
  const withPostcode    = all.filter(p => p.postcode);
  const withoutPostcode = all.filter(p => !p.postcode);
  const pcConfs         = withPostcode.map(p => p.postcode_confidence).filter(v => typeof v === 'number');
  const lowPcConf       = withPostcode.filter(p => typeof p.postcode_confidence === 'number' && p.postcode_confidence < POSTCODE_CONFIDENCE_THRESHOLD);

  const pcSourceMap = {};
  for (const p of withPostcode) {
    const src = p.postcode_source || '(unknown)';
    pcSourceMap[src] = (pcSourceMap[src] || 0) + 1;
  }
  const pcSources = POSTCODE_SOURCE_ORDER
    .filter(s => pcSourceMap[s])
    .map(s => [s, pcSourceMap[s]])
    .concat(Object.entries(pcSourceMap).filter(([s]) => !POSTCODE_SOURCE_ORDER.includes(s)));

  console.log(`\n── Postcode Coverage ─────────────────────────────────────`);
  console.log(`   With postcode:                ${String(withPostcode.length).padStart(4)}`);
  console.log(`   Without postcode:             ${String(withoutPostcode.length).padStart(4)}`);
  if (pcConfs.length) {
    console.log(`   Avg postcode confidence:      ${String(avg(pcConfs)).padStart(4)}`);
    console.log(`   Low-confidence postcodes (<${POSTCODE_CONFIDENCE_THRESHOLD}): ${String(lowPcConf.length).padStart(4)}`);
  }

  if (pcSources.length) {
    console.log(`\n── Postcode Sources ──────────────────────────────────────`);
    for (const [src, count] of pcSources) {
      console.log(`   ${src.padEnd(22)} ${String(count).padStart(4)}`);
    }
  }

  if (lowPcConf.length > 0) {
    if (showPostcodeDetail) {
      console.log(`\n── Low-Confidence Postcodes (<${POSTCODE_CONFIDENCE_THRESHOLD}) ──────────────────────`);
      console.log(`   ${'Domain'.padEnd(32)} ${'Postcode'.padEnd(10)} ${'Src'.padEnd(12)} ${'Conf'.padStart(4)}`);
      console.log(`   ${'─'.repeat(32)} ${'─'.repeat(10)} ${'─'.repeat(12)} ${'─'.repeat(4)}`);
      for (const p of lowPcConf.sort((a, b) => (a.postcode_confidence ?? 999) - (b.postcode_confidence ?? 999))) {
        console.log(
          `   ${p.website.padEnd(32)} ${(p.postcode || '').padEnd(10)} ` +
          `${(p.postcode_source || '').padEnd(12)} ${String(p.postcode_confidence ?? '—').padStart(4)}`
        );
      }
    } else {
      console.log(`   Run with --postcode-detail to list low-confidence postcodes`);
    }
  }

  // ── Active flags ─────────────────────────────────────────────────────────────
  const flagged = all.filter(p => Array.isArray(p.pipeline_flags) && p.pipeline_flags.length > 0);
  if (flagged.length) {
    const flagCounts = {};
    for (const p of flagged) {
      for (const f of p.pipeline_flags) {
        flagCounts[f.code] = (flagCounts[f.code] || 0) + 1;
      }
    }
    console.log(`\n── Active Flags ──────────────────────────────────────────`);
    for (const [code, count] of Object.entries(flagCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`   ${code.padEnd(28)} ${String(count).padStart(4)}`);
    }
    console.log(`\n   Run: node scripts/pipeline/review.js  to view queue`);
  }

  // ── Rescan outlook ────────────────────────────────────────────────────────────
  const now     = new Date();
  const in30    = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const dueSoon = all.filter(p => p.rescan_due_at && new Date(p.rescan_due_at) <= in30 && p.pipeline_status === 'scan_complete');
  const overdue = all.filter(p => p.pipeline_status === 'scan_due');

  if (overdue.length || dueSoon.length) {
    console.log(`\n── Rescan Outlook ────────────────────────────────────────`);
    if (overdue.length) console.log(`   Overdue (scan_due):         ${overdue.length}`);
    if (dueSoon.length) console.log(`   Due within 30 days:         ${dueSoon.length}`);
  }

  console.log(`\n${'═'.repeat(60)}\n`);

  return {
    all,
    byStatus,
    bySector,
    sourceMap,
    avgFirmConf:          avg(firmConfs),
    avgDomainConf:        avg(domainConfs),
    lowConfidenceCount:   lowAny.length,
    postcodeWithCount:    withPostcode.length,
    postcodeWithoutCount: withoutPostcode.length,
    avgPostcodeConf:      avg(pcConfs),
    lowPostcodeConfCount: lowPcConf.length,
  };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const showLowDetail      = process.argv.includes('--low-confidence-detail');
  const showPostcodeDetail = process.argv.includes('--postcode-detail');
  run({ showLowDetail, showPostcodeDetail }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
