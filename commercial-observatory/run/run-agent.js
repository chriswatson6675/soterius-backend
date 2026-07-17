#!/usr/bin/env node
'use strict';

// Manual CLI — runs the bounded, autonomous Commercial Observatory Research
// Agent against an existing Investigation.
//
// Usage:
//   node backend/commercial-observatory/run/run-agent.js \
//     --investigation-id=<UUID> --dry-run
//
//   node backend/commercial-observatory/run/run-agent.js \
//     --investigation-id=<UUID> --apply
//
// Exactly one of --dry-run / --apply is required — defaulting to live
// writes is forbidden by design (Part 11).

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { parseArgs } = require('./args');
const { runResearchAgent } = require('../agent/orchestrator');
const persistence = require('../persistence/db');

function printSection(title) {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const investigationId = typeof args.investigationId === 'string' ? args.investigationId : undefined;
  const dryRunFlag = args.dryRun === true;
  const applyFlag = args.apply === true;

  if (!investigationId) {
    process.stderr.write('Usage: node run-agent.js --investigation-id=<UUID> (--dry-run | --apply)\n');
    process.exitCode = 1;
    return;
  }
  if (dryRunFlag === applyFlag) {
    process.stderr.write('Exactly one of --dry-run or --apply is required. Defaulting to live writes is forbidden.\n');
    process.exitCode = 1;
    return;
  }

  const dryRun = dryRunFlag;
  process.stdout.write(`Investigation ID: ${investigationId}\n`);
  process.stdout.write(`Mode: ${dryRun ? 'DRY RUN (real research, zero database writes)' : 'APPLY (live persistence)'}\n`);

  let bundleBefore = null;
  if (dryRun) {
    const before = await persistence.getInvestigationBundle(investigationId);
    if (before.success) bundleBefore = before.bundle;
  }

  const result = await runResearchAgent(investigationId, { dryRun });

  if (!result.success) {
    process.stderr.write(`Failed: ${result.error}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Final status: ${result.status}\n`);
  process.stdout.write(`Stop reason: ${result.stopReason}\n`);
  process.stdout.write(`Elapsed: ${Math.round(result.elapsedMs / 1000)}s\n`);

  printSection('Resource usage (used / max)');
  for (const key of Object.keys(result.usage)) {
    process.stdout.write(`  ${key}: ${result.usage[key]}\n`);
  }

  printSection(`Tool calls (${result.toolCallLog.length})`);
  for (const c of result.toolCallLog) {
    process.stdout.write(`  ${c.success ? 'OK  ' : 'FAIL'} ${c.toolName} ${JSON.stringify(c.toolInput)}\n`);
  }

  printSection(`Search queries executed (${result.searchQueriesExecuted.length})`);
  for (const q of result.searchQueriesExecuted) process.stdout.write(`  [${q.provider || 'unknown'}] "${q.query}" -> ${q.resultCount} result(s)\n`);

  printSection(`External sources fetched (${result.externalSourcesFetched.length})`);
  for (const s of result.externalSourcesFetched) process.stdout.write(`  ${s.url} — "${s.title || ''}"\n`);

  printSection(`Co-parties investigated (${result.coPartiesInvestigated.length})`);
  for (const name of result.coPartiesInvestigated) process.stdout.write(`  ${name}\n`);

  printSection(`Co-party aliases merged (${result.coPartyAliasesMerged.length})`);
  for (const m of result.coPartyAliasesMerged) process.stdout.write(`  ${m.canonicalKey}: "${m.primaryName}" + alias(es) ${JSON.stringify(m.aliases)}\n`);

  printSection(`Actions skipped due to canonical dedup (${result.actionsSkippedDueToDedup.length})`);
  for (const a of result.actionsSkippedDueToDedup) process.stdout.write(`  ${a}\n`);

  printSection(`Duplicate fetch actions skipped (${result.duplicateActionsSkipped.length})`);
  for (const d of result.duplicateActionsSkipped) {
    process.stdout.write(`  [${d.toolName}] requested=${d.requestedUrl} canonical=${d.canonicalUrl} question=${d.questionId || '(none)'} — ${d.reason}\n`);
  }

  printSection(`Search results selected (${result.searchResultsSelected.length})`);
  for (const r of result.searchResultsSelected) process.stdout.write(`  [${r.category}] ${r.url} (score ${r.score})\n`);

  printSection(`Search results rejected (${result.searchResultsRejected.length})`);
  for (const r of result.searchResultsRejected) process.stdout.write(`  [${r.reason}] ${r.url}\n`);

  printSection(`Sources assessed by Source Intelligence (${result.sourcesAssessed.length})`);
  for (const s of result.sourcesAssessed) process.stdout.write(`  [${s.recommendation}] [${s.classification}] score=${s.compositeScore} ${s.url}\n`);

  printSection(`Sources skipped by Source Intelligence (${result.sourcesSkippedBySourceIntelligence.length})`);
  for (const s of result.sourcesSkippedBySourceIntelligence) process.stdout.write(`  [${s.classification}] score=${s.compositeScore} (${s.context}) ${s.url} — ${s.reasons.join(' ')}\n`);

  printSection('Findings');
  process.stdout.write(JSON.stringify(result.findings, null, 2) + '\n');

  printSection(`Rejected findings (${result.rejectedFindings.length})`);
  for (const r of result.rejectedFindings) process.stdout.write(`  ${JSON.stringify(r)}\n`);

  if (dryRun) {
    printSection(`Would persist — evidence (${result.wouldPersistEvidence.length})`);
    for (const e of result.wouldPersistEvidence) process.stdout.write(`  ${JSON.stringify(e)}\n`);
    printSection(`Would persist — claims (${result.wouldPersistClaims.length})`);
    for (const c of result.wouldPersistClaims) process.stdout.write(`  ${JSON.stringify(c)}\n`);
    printSection(`Would persist — relationships (${result.wouldPersistRelationships.length})`);
    for (const r of result.wouldPersistRelationships) process.stdout.write(`  ${r.rawName} — ${r.relationshipType} (${r.relationshipDirection})\n`);
    printSection(`Would persist — discoveries (${result.wouldPersistDiscoveries.length})`);
    for (const d of result.wouldPersistDiscoveries) process.stdout.write(`  ${JSON.stringify(d)}\n`);
  }

  printSection('Proposed draft');
  process.stdout.write(JSON.stringify(result.draft, null, 2) + '\n');

  printSection(`Open questions remaining (${result.questions.filter((q) => q.status === 'open').length})`);
  for (const q of result.questions.filter((q) => q.status === 'open')) process.stdout.write(`  [${q.priority}] ${q.id}: ${q.reason}\n`);

  if (dryRun && bundleBefore) {
    const after = await persistence.getInvestigationBundle(investigationId);
    const bundleAfter = after.success ? after.bundle : null;
    const identical = bundleAfter && JSON.stringify(bundleBefore) === JSON.stringify(bundleAfter);
    printSection('Database state verification (dry-run)');
    process.stdout.write(`  Bundle read before run: claims=${bundleBefore.claims.length} evidence=${bundleBefore.evidence.length} relationships=${bundleBefore.relationshipObservations.length} discoveries=${bundleBefore.discoveries.length} agentEvents=${bundleBefore.agentEvents.length}\n`);
    if (bundleAfter) {
      process.stdout.write(`  Bundle read after run:  claims=${bundleAfter.claims.length} evidence=${bundleAfter.evidence.length} relationships=${bundleAfter.relationshipObservations.length} discoveries=${bundleAfter.discoveries.length} agentEvents=${bundleAfter.agentEvents.length}\n`);
    }
    process.stdout.write(`  Byte-identical before/after: ${identical ? 'YES — zero database writes confirmed' : 'NO — mismatch detected'}\n`);
  }

  process.stdout.write(`\nDatabase writes performed: ${dryRun ? 0 : '(see status/persistence above)'}\n`);
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exitCode = 1;
});
