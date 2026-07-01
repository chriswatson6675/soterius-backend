'use strict';
/**
 * Pipeline Orchestrator
 *
 * Runs the full Research Pipeline V1 end-to-end, or a named stage subset.
 * Designed to be run manually or on a schedule.
 *
 * Stages (in order):
 *   1. maintain  — promote overdue rescans, re-queue failed scans
 *   2. validate  — domain reachability + parked page checks
 *   3. clean     — data quality flagging (missing sector, duplicates)
 *   4. scan      — bulk scan all valid/pending_scan/scan_due prospects
 *   5. review    — print the human review queue
 *   6. status    — print pipeline dashboard
 *
 * Usage:
 *   node scripts/pipeline/run.js                        # full pipeline
 *   node scripts/pipeline/run.js --stages validate,scan # specific stages
 *   node scripts/pipeline/run.js --scan-limit 10        # limit scans per run
 *   node scripts/pipeline/run.js --rescan               # include scan_due
 *   node scripts/pipeline/run.js --dry-run              # no writes (validate + clean only)
 *   node scripts/pipeline/run.js --status               # status only
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { log, warn, error } = require('./lib/log');

const STAGE_MODULES = {
  maintain: './maintain',
  validate: './validate',
  clean:    './clean',
  scan:     './scan',
  review:   './review',
  status:   './status',
};

const DEFAULT_STAGES = ['maintain', 'validate', 'clean', 'scan', 'review', 'status'];

async function run(opts = {}) {
  const {
    stages    = DEFAULT_STAGES,
    scanLimit = 0,
    rescan    = false,
    dryRun    = false,
  } = opts;

  log(`Research Pipeline V1 — starting stages: ${stages.join(', ')}`);
  if (dryRun) warn('Dry-run mode: no writes will be made (applies to validate, clean)');

  const results = {};

  for (const stage of stages) {
    if (!STAGE_MODULES[stage]) {
      warn(`Unknown stage "${stage}" — skipping`);
      continue;
    }

    log(`\n── Stage: ${stage} ${'─'.repeat(50 - stage.length)}`);

    const stageModule = require(STAGE_MODULES[stage]);
    const stageOpts   = {};

    if (stage === 'scan')     { stageOpts.limit = scanLimit; stageOpts.rescan = rescan; }
    if (stage === 'clean')    { stageOpts.dryRun = dryRun; }
    if (stage === 'validate') { /* no extra opts */ }

    try {
      results[stage] = await stageModule.run(stageOpts);
    } catch (err) {
      error(`Stage "${stage}" failed: ${err.message}`);
      results[stage] = { error: err.message };
    }
  }

  log('\nPipeline run complete.');
  return results;
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args       = process.argv.slice(2);
  const stagesIdx  = args.indexOf('--stages');
  const limitIdx   = args.indexOf('--scan-limit');
  const statusOnly = args.includes('--status');

  const stages = statusOnly
    ? ['status']
    : stagesIdx !== -1
      ? args[stagesIdx + 1].split(',').map(s => s.trim())
      : DEFAULT_STAGES;

  const scanLimit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 0;
  const rescan    = args.includes('--rescan');
  const dryRun    = args.includes('--dry-run');

  run({ stages, scanLimit, rescan, dryRun }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
