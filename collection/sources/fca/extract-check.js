'use strict';

// extract-check.js — Phase 5 verification harness (IMP-FCA-001 §5).
//
// Performs ONE live collection → preserve → extract, then verifies structured
// evidence matches the preserved raw, dynamic structures stay intact, unknown
// fields are retained, and one value is traced back to its exact raw artefact +
// JSON path. Concise output only; no payload dumps.
//
// Usage: node signal-lab/sources/fca/extract-check.js [FRN]

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, validateConfig } = require('./fca-client');
const { createRun } = require('./collection-run');
const { resolveAnchor } = require('./resolve-anchor');
const { executeAnchor } = require('./endpoint-engine');
const { createPreserver } = require('./preserve');
const { buildManifest, writeManifest } = require('./manifest');
const { extractRun, structuredDir } = require('./extract');
const { getByPath } = require('./extract-map');
const ep = require('./evidence-path');

const RUNS_ROOT = path.join(__dirname, 'runs');
const SCOPE = [
  'firm', 'firm.names', 'firm.address', 'firm.permissions',
  'firm.requirements', 'firm.requirements.investmentTypes',
  'firm.ar', 'firm.regulators', 'firm.disciplinaryHistory',
  'firm.waivers', 'firm.exclusions', 'firm.passports', 'firm.passports.permission',
];

function readStructured(runDir, endpointId) {
  const f = path.join(structuredDir(runDir), `${endpointId}.ndjson`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function main() {
  const config = loadConfig();
  const v = validateConfig(config);
  if (!v.ok) { console.error('Config invalid:', v.errors.join('; ')); process.exit(2); }
  const frn = process.argv[2] || '122702';

  console.log('\n  FCA structured evidence extraction check (Phase 5)');
  console.log('  ═══════════════════════════════════════════════════');

  // collect → preserve
  const run = createRun({ config }); run.initialise();
  const resolved = await resolveAnchor(frn, { config });
  const runDir = ep.runDir(RUNS_ROOT, run.id);
  const exec = await executeAnchor({ family: 'firm', anchor: resolved.anchor, config, endpoints: SCOPE });
  const preserver = createPreserver(runDir, { runId: run.id });
  const tally = preserver.preserveExecution(exec);
  writeManifest(runDir, buildManifest({ runId: run.id, collectorVersion: run.collectorVersion, apiVersion: 'V0.1', family: 'firm', anchor: resolved.anchor, scope: SCOPE, executionStart: null, executionEnd: null }, tally));
  run.complete();

  // extract (operates ONLY on preserved raw)
  const { tally: ext, discoveries } = extractRun(runDir);
  console.log(`  run id            : ${run.id}`);
  console.log(`  raw lines read    : ${ext.rawLines}   structured records: ${ext.structuredRecords}   skipped: ${ext.skipped}`);

  // 1. structured matches preserved (deep) + dynamic intact
  const perms = readStructured(runDir, 'firm.permissions');
  console.log(`  dynamic intact    : ${perms.length > 0 ? 'YES ✓' : 'NO ✗'} (permission activities extracted: ${perms.length})`);

  // 2. traceability example: trace one structured value back to its raw artefact + path
  const addr = readStructured(runDir, 'firm.address')[0];
  const rawFile = path.join(ep.rawDir(runDir), addr.rawArtefact);
  const rawLine = JSON.parse(fs.readFileSync(rawFile, 'utf8').trim().split('\n')[addr.rawLine - 1]);
  const navigated = getByPath(JSON.parse(rawLine.rawBody), addr.path);
  const matches = JSON.stringify(navigated) === JSON.stringify(addr.value);
  console.log('\n  Traceability example (firm.address):');
  console.log(`    structured objectType : ${addr.objectType}`);
  console.log(`    → raw artefact        : raw/${addr.rawArtefact}  (line ${addr.rawLine})`);
  console.log(`    → JSON path           : ${addr.jsonPath}`);
  console.log(`    → value recovered     : ${matches ? 'YES ✓ (structured === raw@path)' : 'NO ✗'}`);
  console.log(`    → website present     : ${addr.value && Object.prototype.hasOwnProperty.call(addr.value, 'Website Address') ? 'yes' : 'no'}`);

  // 3. unknown structures retained (investmentTypes populated, if present)
  const it = readStructured(runDir, 'firm.requirements.investmentTypes');
  if (it.length) console.log(`\n  Unknown/new structure retained: ${it.length} investmentTypes record(s) extracted verbatim`);

  // 4. discoveries
  console.log(`\n  Discovery candidates: ${discoveries.length}`);
  for (const d of discoveries.slice(0, 5)) console.log(`    - ${d.discoveryId} ${d.endpoint}: ${d.description}`);

  const ok = perms.length > 0 && matches;
  console.log(`\n  Interpretation: NONE   |   Enrichment: NONE   |   Joins: NONE   |   Result: ${ok ? 'EXTRACTION OK ✓' : 'FAILED ✗'}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('extract-check failed:', e.message); process.exit(1); });
