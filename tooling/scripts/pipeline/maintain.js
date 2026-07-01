'use strict';
/**
 * Pipeline Stage 5 — Benchmark Maintenance
 *
 * Manages the ongoing health of the benchmark dataset:
 *   1. Promotes scan_complete → scan_due when rescan_due_at is past
 *   2. Re-queues scan_failed → pending_validate for retry
 *   3. Prints a summary of what is due in the next N days
 *
 * Run this on a schedule (e.g. daily) to keep the pipeline moving.
 *
 * Usage:
 *   node scripts/pipeline/maintain.js [--preview-days 30]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { log, warn } = require('./lib/log');
const { updatePipelineStatus, getAllProspects } = require('./lib/db');
const { error } = require('./lib/log');

const DEFAULT_PREVIEW_DAYS = 30;

async function run({ previewDays = DEFAULT_PREVIEW_DAYS } = {}) {
  const all = await getAllProspects();
  const now  = new Date();

  const stats = { promoted: 0, retried: 0, dueSoon: 0 };

  for (const p of all) {
    // Promote scan_complete → scan_due if rescan window has passed
    if (p.pipeline_status === 'scan_complete' && p.rescan_due_at) {
      if (new Date(p.rescan_due_at) <= now) {
        await updatePipelineStatus(p.id, 'scan_due');
        log(`Promoted to scan_due: ${p.website} (was due ${p.rescan_due_at})`);
        stats.promoted++;
      }
    }

    // Re-queue scan_failed for re-validation
    if (p.pipeline_status === 'scan_failed') {
      await updatePipelineStatus(p.id, 'pending_validate', {
        pipeline_notes: `Re-queued for validation after scan failure (${now.toISOString()})`,
      });
      warn(`Re-queued for validation: ${p.website}`);
      stats.retried++;
    }

    // Count what is due within previewDays
    if (p.pipeline_status === 'scan_complete' && p.rescan_due_at) {
      const dueDate   = new Date(p.rescan_due_at);
      const daysUntil = (dueDate - now) / (1000 * 60 * 60 * 24);
      if (daysUntil >= 0 && daysUntil <= previewDays) {
        stats.dueSoon++;
      }
    }
  }

  log(`Maintenance complete — promoted: ${stats.promoted}, retried: ${stats.retried}, due within ${previewDays}d: ${stats.dueSoon}`);
  return stats;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args        = process.argv.slice(2);
  const daysIdx     = args.indexOf('--preview-days');
  const previewDays = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : DEFAULT_PREVIEW_DAYS;

  run({ previewDays }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
