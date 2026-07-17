#!/usr/bin/env node
'use strict';

// Manual CLI — starts one Commercial Observatory Investigation.
//
// Usage:
//   node backend/commercial-observatory/run/create-investigation.js \
//     --domain=complianceoffice.co.uk --name="Compliance Office"
//
// Backend-only, foreground, no LLM/web-search/worker involved (see
// domain/create-investigation.js). Never prints environment variables or
// credentials — only the created investigation id and the initial dossier.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { parseArgs } = require('./args');
const { createInvestigation } = require('../domain/create-investigation');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const domain = typeof args.domain === 'string' ? args.domain : undefined;
  const name = typeof args.name === 'string' ? args.name : undefined;

  if (!domain && !name) {
    process.stderr.write('Usage: node create-investigation.js --domain=<domain> [--name="<Organisation Name>"]\n');
    process.exitCode = 1;
    return;
  }

  const result = await createInvestigation({ name, domain });

  if (!result.success) {
    process.stderr.write(`Failed to create investigation: ${result.error}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Investigation created: ${result.investigationId}\n`);
  process.stdout.write('\nInitial Organisation Dossier:\n');
  process.stdout.write(JSON.stringify(result.dossier.workingState, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exitCode = 1;
});
