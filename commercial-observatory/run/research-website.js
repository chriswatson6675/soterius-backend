#!/usr/bin/env node
'use strict';

// Manual CLI — runs the deterministic website-research vertical slice
// against an existing Investigation.
//
// Usage:
//   node backend/commercial-observatory/run/research-website.js \
//     --investigation-id=<UUID>
//
// Backend-only, foreground, no LLM. Exits non-zero only when the
// Investigation itself ends in a fatal failure (setup error, or the
// homepage was unreachable over both HTTPS and HTTP) — a "partial"
// research outcome is a successful tool run and exits 0.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { parseArgs } = require('./args');
const { researchWebsite } = require('../research/research-website');

function printSection(title) {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const investigationId = typeof args.investigationId === 'string' ? args.investigationId : undefined;

  if (!investigationId) {
    process.stderr.write('Usage: node research-website.js --investigation-id=<UUID>\n');
    process.exitCode = 1;
    return;
  }

  const result = await researchWebsite(investigationId);

  process.stdout.write(`Investigation ID: ${investigationId}\n`);

  if (!result.success) {
    process.stdout.write(`Final status: failed\n`);
    process.stdout.write(`Error: ${result.error}\n`);
    if (result.homepage) process.stdout.write(`Homepage fetch: ${JSON.stringify(result.homepage)}\n`);
    if (result.failures) process.stdout.write(`Failures: ${JSON.stringify(result.failures, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Final status: ${result.status}\n`);

  printSection('Homepage fetch');
  process.stdout.write(`${JSON.stringify(result.homepage, null, 2)}\n`);

  printSection(`Pages selected (${result.pagesSelected.length})`);
  for (const p of result.pagesSelected) process.stdout.write(`  [${p.category || 'uncategorised'}] ${p.url} (score ${p.score})\n`);

  printSection(`Pages visited (${result.pagesVisited.length})`);
  for (const p of result.pagesVisited) process.stdout.write(`  [${p.category}] ${p.url} -> evidence ${p.evidenceId}\n`);

  printSection(`Pages rejected (${result.pagesRejected.length})`);
  for (const p of result.pagesRejected) process.stdout.write(`  ${p.url} — ${p.reason}\n`);

  printSection('Evidence');
  process.stdout.write(`New evidence records created this run: ${result.evidenceCreated}\n`);

  printSection(`External organisations detected — relationship observations (${result.relationshipObservationsCreated.length})`);
  for (const r of result.relationshipObservationsCreated) {
    process.stdout.write(`  ${r.thirdPartyName} — ${r.relationshipType} (${r.relationshipDirection}, ${r.relationshipConfidenceState}, confidence: ${r.confidence})\n`);
    process.stdout.write(`    context: "${r.contextExcerpt}"\n`);
  }

  printSection(`Contextual mentions (not promoted to a relationship) (${result.contextualMentions.length})`);
  for (const m of result.contextualMentions) {
    process.stdout.write(`  ${m.rawName} (${m.detectionMethod}) — "${m.contextExcerpt}"\n`);
  }

  printSection(`Discoveries created (${result.discoveriesCreated.length})`);
  for (const d of result.discoveriesCreated) process.stdout.write(`  ${d.discoveredName} (${d.discoveredDomain || 'no domain'}) — ${d.discoveryReason}\n`);

  printSection(`Unanswered questions (${result.unansweredQuestions.length})`);
  for (const q of result.unansweredQuestions) process.stdout.write(`  - ${q}\n`);

  printSection('Dossier completeness');
  process.stdout.write(`${result.completeness}\n`);

  printSection(`Failures (${result.failures.length})`);
  for (const f of result.failures) process.stdout.write(`  ${JSON.stringify(f)}\n`);
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exitCode = 1;
});
