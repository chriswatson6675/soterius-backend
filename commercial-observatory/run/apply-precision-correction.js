#!/usr/bin/env node
'use strict';

// Manual CLI — re-reviews an Investigation's already-persisted relationship
// observations against the (fixed) relationship assertion model, using
// only each row's own stored context excerpt (no refetch, no LLM).
//
// Usage:
//   node backend/commercial-observatory/run/apply-precision-correction.js \
//     --investigation-id=<UUID>
//
// Never mutates or deletes commercial_relationship_observations rows —
// see research/relationship-correction.js for the append-only-respecting
// correction mechanism this CLI drives.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { parseArgs } = require('./args');
const { reviewExistingRelationshipObservations } = require('../research/relationship-correction');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const investigationId = typeof args.investigationId === 'string' ? args.investigationId : undefined;

  if (!investigationId) {
    process.stderr.write('Usage: node apply-precision-correction.js --investigation-id=<UUID>\n');
    process.exitCode = 1;
    return;
  }

  const result = await reviewExistingRelationshipObservations(investigationId);

  if (!result.success) {
    process.stderr.write(`Failed to review relationship observations: ${result.error}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Investigation ID: ${investigationId}\n`);
  process.stdout.write(`Already-corrected (skipped): ${result.alreadyCorrected.length}\n`);
  process.stdout.write(`Newly corrected: ${result.corrected.length}\n`);
  for (const c of result.corrected) {
    process.stdout.write(`\n  - ${c.thirdPartyName} (${c.relationshipType})\n`);
    process.stdout.write(`    classification: ${c.classification}\n`);
    process.stdout.write(`    reason: ${c.reason}\n`);
    process.stdout.write(`    context: "${c.contextExcerpt}"\n`);
  }
  process.stdout.write('\n');
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exitCode = 1;
});
