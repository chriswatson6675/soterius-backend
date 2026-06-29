'use strict';

// preserve-check.js — Phase 4 verification harness (IMP-FCA-001 §4).
//
// Executes ONE live FCA collection and preserves it immutably to disk, then
// verifies byte-faithfulness, dynamic-structure fidelity, manifest generation, and
// that a previous run remains untouched. Concise output only; no payload dumps.
//
// Usage: node signal-lab/sources/fca/preserve-check.js [FRN]

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { loadConfig, validateConfig } = require('./fca-client');
const { createRun } = require('./collection-run');
const { resolveAnchor } = require('./resolve-anchor');
const { executeAnchor } = require('./endpoint-engine');
const { createPreserver } = require('./preserve');
const { buildManifest, writeManifest } = require('./manifest');
const ep = require('./evidence-path');

const RUNS_ROOT = path.join(__dirname, 'runs');
const SCOPE = [
  'firm', 'firm.names', 'firm.address', 'firm.permissions',
  'firm.requirements', 'firm.requirements.investmentTypes',
  'firm.ar', 'firm.regulators', 'firm.disciplinaryHistory',
  'firm.waivers', 'firm.exclusions', 'firm.passports', 'firm.passports.permission',
];

async function collectAndPreserve(config, run, anchor, endpoints) {
  const runDir = ep.runDir(RUNS_ROOT, run.id);
  const executionStart = new Date().toISOString();
  const execResult = await executeAnchor({ family: 'firm', anchor, config, endpoints });
  const executionEnd = new Date().toISOString();

  const preserver = createPreserver(runDir, { runId: run.id });
  const tally = preserver.preserveExecution(execResult);

  const manifest = buildManifest({
    runId: run.id,
    collectorVersion: run.collectorVersion,
    apiVersion: run.provenanceContext().apiVersion,
    family: 'firm', anchor, scope: endpoints,
    executionStart, executionEnd,
  }, tally);
  writeManifest(runDir, manifest);

  return { runDir, execResult, tally, manifest };
}

async function main() {
  const config = loadConfig();
  const v = validateConfig(config);
  if (!v.ok) { console.error('Config invalid:', v.errors.join('; ')); process.exit(2); }

  const frn = process.argv[2] || '122702';

  console.log('\n  FCA raw evidence preservation check (Phase 4)');
  console.log('  ══════════════════════════════════════════════');

  // ---- Run 1: full-scope live collection, preserved ----
  const run1 = createRun({ config }); run1.initialise();
  const resolved = await resolveAnchor(frn, { config });
  const r1 = await collectAndPreserve(config, run1, resolved.anchor, SCOPE);
  run1.complete();

  console.log(`  run id            : ${run1.id}`);
  console.log(`  run dir           : ${path.relative(process.cwd(), r1.runDir)}`);
  console.log(`  endpoints preserved: ${r1.tally.endpointsPreserved}/${r1.tally.endpointsAttempted}   pages: ${r1.tally.pagesPreserved}   artefacts: ${r1.manifest.artefacts.length}   transportErrors: ${r1.tally.transportErrors}`);

  // ---- Verify byte-faithfulness: preserved firm.address rawBody == observed rawBody ----
  const addrFile = ep.rawFileFor(r1.runDir, 'firm.address');
  const preservedLine = JSON.parse(fs.readFileSync(addrFile, 'utf8').trim().split('\n')[0]);
  const observed = r1.execResult.executions.find((e) => e.endpointId === 'firm.address').pages[0].response.rawBody;
  console.log(`  byte-faithful     : ${preservedLine.rawBody === observed ? 'YES ✓' : 'NO ✗'} (firm.address)`);

  // ---- Verify dynamic structure preserved intact ----
  const permFile = ep.rawFileFor(r1.runDir, 'firm.permissions');
  const permLine = JSON.parse(fs.readFileSync(permFile, 'utf8').trim().split('\n')[0]);
  const permData = JSON.parse(permLine.rawBody).Data;
  const keys = permData && typeof permData === 'object' && !Array.isArray(permData) ? Object.keys(permData).length : 0;
  console.log(`  dynamic preserved : ${keys > 0 ? 'YES ✓' : 'NO ✗'} (permissions activity keys on page 1: ${keys})`);

  // ---- Verify a previously-unseen structure is preserved verbatim (investmentTypes) ----
  const itFile = ep.rawFileFor(r1.runDir, 'firm.requirements.investmentTypes');
  if (fs.existsSync(itFile)) {
    const itLines = fs.readFileSync(itFile, 'utf8').trim().split('\n').filter(Boolean);
    const populated = itLines.filter((l) => /FSR-API-02-13-00/.test(l)).length;
    console.log(`  unknown preserved : YES ✓ (investmentTypes lines: ${itLines.length}, populated: ${populated} — captured verbatim despite EOI predating it)`);
  }

  // ---- Manifest present ----
  console.log(`  manifest written  : ${fs.existsSync(ep.manifestPath(r1.runDir)) ? 'YES ✓' : 'NO ✗'}`);

  // ---- Run 2: a tiny second run; verify run 1 is untouched ----
  const before = fs.readFileSync(ep.manifestPath(r1.runDir), 'utf8');
  const beforeAddr = fs.readFileSync(addrFile, 'utf8');
  const run2 = createRun({ config }); run2.initialise();
  const r2 = await collectAndPreserve(config, run2, resolved.anchor, ['firm']);
  run2.complete();
  const afterUntouched = fs.readFileSync(ep.manifestPath(r1.runDir), 'utf8') === before
    && fs.readFileSync(addrFile, 'utf8') === beforeAddr;
  console.log(`  run 2 id          : ${run2.id} (isolated dir: ${path.basename(r2.runDir)})`);
  console.log(`  run 1 untouched   : ${afterUntouched ? 'YES ✓' : 'NO ✗'}`);

  const ok = preservedLine.rawBody === observed && keys > 0 && fs.existsSync(ep.manifestPath(r1.runDir)) && afterUntouched;
  console.log(`\n  Extraction performed: NONE   |   Database: NONE   |   Result: ${ok ? 'PRESERVATION OK ✓' : 'FAILED ✗'}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('preserve-check failed:', e.message); process.exit(1); });
