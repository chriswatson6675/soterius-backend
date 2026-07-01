'use strict';
/**
 * Pipeline Stage 6 — Human Review Queue
 *
 * Lists all prospects that require human attention:
 *   - pipeline_status = 'flagged'
 *   - pipeline_status = 'invalid'
 *   - pipeline_flags contains unresolved flag codes
 *
 * Also supports resolving a flagged prospect from the command line:
 *   --resolve <id> --action <valid|exclude>  [--note "reason"]
 *
 * Usage:
 *   node scripts/pipeline/review.js                           # show queue
 *   node scripts/pipeline/review.js --resolve <id> --action valid
 *   node scripts/pipeline/review.js --resolve <id> --action exclude --note "Not a firm website"
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const { log, warn, error } = require('./lib/log');
const { getClient, updatePipelineStatus, getAllProspects } = require('./lib/db');

const REVIEW_STATUSES = ['flagged', 'invalid'];

async function run({ resolve, action, note } = {}) {
  if (resolve) {
    return resolveOne(resolve, action, note);
  }

  const all      = await getAllProspects();
  const queue    = all.filter(p => REVIEW_STATUSES.includes(p.pipeline_status));
  const hasFlags = all.filter(p =>
    !REVIEW_STATUSES.includes(p.pipeline_status) &&
    Array.isArray(p.pipeline_flags) &&
    p.pipeline_flags.length > 0
  );

  if (!queue.length && !hasFlags.length) {
    log('Review queue is empty — no prospects require human attention');
    return { queue: [], flagged: [] };
  }

  if (queue.length) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(` REVIEW QUEUE (${queue.length} prospect${queue.length !== 1 ? 's' : ''})`);
    console.log('═'.repeat(72));
    for (const p of queue) {
      console.log(`\n  ID:      ${p.id}`);
      console.log(`  Firm:    ${p.firm_name}`);
      console.log(`  Domain:  ${p.website}`);
      console.log(`  Status:  ${p.pipeline_status}`);
      console.log(`  Sector:  ${p.sector || '(not set)'}`);
      if (Array.isArray(p.pipeline_flags) && p.pipeline_flags.length) {
        console.log(`  Flags:`);
        for (const f of p.pipeline_flags) {
          console.log(`    • [${f.code}] ${f.detail}`);
        }
      }
      if (p.pipeline_notes) {
        console.log(`  Notes:   ${p.pipeline_notes}`);
      }
    }
    console.log(`\n  Resolve with:`);
    console.log(`    node scripts/pipeline/review.js --resolve <id> --action valid`);
    console.log(`    node scripts/pipeline/review.js --resolve <id> --action exclude --note "reason"`);
  }

  if (hasFlags.length) {
    console.log(`\n${'─'.repeat(72)}`);
    console.log(` PROSPECTS WITH UNRESOLVED FLAGS (${hasFlags.length})`);
    console.log('─'.repeat(72));
    for (const p of hasFlags) {
      console.log(`\n  ID: ${p.id}  Domain: ${p.website}  Status: ${p.pipeline_status}`);
      for (const f of p.pipeline_flags) {
        console.log(`    • [${f.code}] ${f.detail}`);
      }
    }
  }

  console.log('');
  return { queue, flagged: hasFlags };
}

async function resolveOne(id, action, note) {
  const allowed = ['valid', 'exclude'];
  if (!action || !allowed.includes(action)) {
    throw new Error(`--action must be one of: ${allowed.join(', ')}`);
  }

  const targetStatus = action === 'valid' ? 'pending_scan' : 'excluded';

  await updatePipelineStatus(id, targetStatus, {
    pipeline_flags: [],
    pipeline_notes: note ? `Human review: ${note} (${new Date().toISOString()})` : null,
  });

  log(`Resolved prospect ${id} → ${targetStatus}${note ? ` (note: "${note}")` : ''}`);
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args      = process.argv.slice(2);
  const resolveIdx = args.indexOf('--resolve');
  const actionIdx  = args.indexOf('--action');
  const noteIdx    = args.indexOf('--note');

  const resolve = resolveIdx !== -1 ? args[resolveIdx + 1] : null;
  const action  = actionIdx  !== -1 ? args[actionIdx  + 1] : null;
  const note    = noteIdx    !== -1 ? args[noteIdx    + 1] : null;

  run({ resolve, action, note }).catch(err => {
    error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
