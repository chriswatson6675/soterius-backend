#!/usr/bin/env node
'use strict';

// Manual CLI — prints the complete, reviewable bundle for one Investigation
// (investigation, dossier, claims, evidence, relationship observations,
// discoveries, agent events, draft).
//
// Usage:
//   node backend/commercial-observatory/run/report-investigation.js \
//     --investigation-id=<UUID>
//
// Read-only. Never prints environment variables or credentials.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { parseArgs } = require('./args');
const { getInvestigationBundle } = require('../persistence/db');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const investigationId = typeof args.investigationId === 'string' ? args.investigationId : undefined;

  if (!investigationId) {
    process.stderr.write('Usage: node report-investigation.js --investigation-id=<UUID>\n');
    process.exitCode = 1;
    return;
  }

  const result = await getInvestigationBundle(investigationId);

  if (!result.success) {
    process.stderr.write(`Failed to load investigation bundle: ${result.error}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(JSON.stringify(result.bundle, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exitCode = 1;
});
