'use strict';
/**
 * Pipeline Stage 4 — Bulk Scanning
 *
 * Scans all prospects in 'valid' or 'pending_scan' status.
 * Also rescans prospects in 'scan_due' where rescan_due_at ≤ now.
 *
 * For each prospect:
 *   1. Runs executeScan(domain)
 *   2. Saves scan record via saveScan()
 *   3. Updates prospect last_scanned and pipeline_status → scan_complete
 *   4. Flags low scores (≤10%) and score regressions (>30pp drop) for review
 *   5. Schedules next rescan at +28 days (rescan_due_at) and marks scan_complete
 *
 * Concurrency: 5 parallel scans, 1.5s pause between batches.
 * Respects 28-day rescan protection window.
 *
 * Usage:
 *   node scripts/pipeline/scan.js [--limit N] [--rescan]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { log, warn, error } = require('./lib/log');
const { updatePipelineStatus, appendFlag, getLatestScan, getProspectsByStatus, getProspectsForRescan } = require('./lib/db');
const { executeScan }  = require('../../services/scanService');
const { saveScan, updateProspectLastScanned } = require('../../services/database');

const CONCURRENCY       = 5;
const BATCH_PAUSE_MS    = 1500;
const RESCAN_DAYS       = 28;
const LOW_SCORE_THRESHOLD  = 10;   // percent
const REGRESSION_THRESHOLD = 30;   // percentage-point drop

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function run({ limit = 0, rescan = false } = {}) {
  let prospects = await getProspectsByStatus('valid');
  const pending  = await getProspectsByStatus('pending_scan');
  prospects = prospects.concat(pending);

  if (rescan) {
    const due = await getProspectsForRescan();
    prospects  = prospects.concat(due);
  }

  // Deduplicate by id
  const seen = new Set();
  prospects = prospects.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });

  if (limit > 0) prospects = prospects.slice(0, limit);

  if (!prospects.length) { log('No prospects ready for scanning'); return; }

  log(`Scanning ${prospects.length} prospect(s)${rescan ? ' (including rescans)' : ''}`);

  const stats = { total: prospects.length, scanned: 0, flagged: 0, errors: 0 };

  for (let i = 0; i < prospects.length; i += CONCURRENCY) {
    const batch = prospects.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(p => scanOne(p, stats)));

    if (i + CONCURRENCY < prospects.length) {
      await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
    }
  }

  log(`Scan complete — scanned: ${stats.scanned}, flagged: ${stats.flagged}, errors: ${stats.errors}`);
  return stats;
}

async function scanOne(prospect, stats) {
  const { id, website: domain } = prospect;

  try {
    await updatePipelineStatus(id, 'pending_scan');

    const result = await executeScan(domain);
    const saved  = await saveScan(domain, result.scoreObject, result.scanners, id);

    if (!saved.success) throw new Error(`saveScan failed: ${saved.error}`);

    await updateProspectLastScanned(id);

    const flags = [];

    // Low score check
    if (result.score <= LOW_SCORE_THRESHOLD) {
      flags.push({
        code:   'LOW_SCORE',
        detail: `Score ${result.score}% ≤ ${LOW_SCORE_THRESHOLD}% threshold — verify domain is the firm's active trading site`,
      });
    }

    // Regression check (compare to previous scan)
    const previousScan = await getLatestScan(id);
    if (previousScan && typeof previousScan.overall_score === 'number') {
      const drop = previousScan.overall_score - result.score;
      if (drop > REGRESSION_THRESHOLD) {
        flags.push({
          code:   'SCORE_REGRESSION',
          detail: `Score dropped ${drop}pp (${previousScan.overall_score}% → ${result.score}%) — exceeds ${REGRESSION_THRESHOLD}pp regression threshold`,
        });
      }
    }

    await updatePipelineStatus(id, 'scan_complete', {
      rescan_due_at: addDays(RESCAN_DAYS),
    });

    for (const f of flags) await appendFlag(id, f);

    if (flags.length) {
      warn(`Scanned (flagged): ${domain} — ${result.score}% — ${flags.map(f => f.code).join(', ')}`);
      stats.flagged++;
    } else {
      log(`Scanned: ${domain} — ${result.score}% (${result.riskLevel})`);
    }
    stats.scanned++;

  } catch (err) {
    error(`Scan failed for ${domain}: ${err.message}`);
    await updatePipelineStatus(id, 'scan_failed', {
      pipeline_notes: `Scan failed: ${err.message} (${new Date().toISOString()})`,
    }).catch(() => {});
    stats.errors++;
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args   = process.argv.slice(2);
  const limIdx  = args.indexOf('--limit');
  const limit   = limIdx !== -1 ? parseInt(args[limIdx + 1], 10) : 0;
  const rescan  = args.includes('--rescan');

  run({ limit, rescan }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
