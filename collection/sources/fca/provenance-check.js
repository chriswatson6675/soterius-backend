'use strict';

// provenance-check.js — Phase 6 verification harness (IMP-FCA-001 §6).
//
// Runs collect → preserve → extract → (additive) provenance lineage, then verifies
// end-to-end lineage and integrity for every structured record, confirms evidence
// is unchanged, and that no credential appears in provenance. Concise output only.
//
// Usage: node signal-lab/sources/fca/provenance-check.js [FRN]

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const { loadConfig, validateConfig } = require('./fca-client');
const { createRun } = require('./collection-run');
const { resolveAnchor } = require('./resolve-anchor');
const { executeAnchor } = require('./endpoint-engine');
const { createPreserver } = require('./preserve');
const { buildManifest, writeManifest, readManifest } = require('./manifest');
const { extractRun, structuredDir } = require('./extract');
const { writeLineage, verifyRun, composeEnvelope, lineagePath } = require('./provenance');
const ep = require('./evidence-path');

const RUNS_ROOT = path.join(__dirname, 'runs');
const SCOPE = ['firm', 'firm.names', 'firm.address', 'firm.permissions', 'firm.requirements', 'firm.requirements.investmentTypes', 'firm.ar', 'firm.regulators', 'firm.disciplinaryHistory', 'firm.waivers', 'firm.exclusions', 'firm.passports', 'firm.passports.permission'];

function hashDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(dir).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return h.digest('hex');
}

async function main() {
  const config = loadConfig();
  const v = validateConfig(config);
  if (!v.ok) { console.error('Config invalid:', v.errors.join('; ')); process.exit(2); }
  const frn = process.argv[2] || '122702';

  console.log('\n  FCA provenance + integrity check (Phase 6)');
  console.log('  ════════════════════════════════════════════');

  // collect → preserve → extract
  const run = createRun({ config }); run.initialise();
  const resolved = await resolveAnchor(frn, { config });
  const runDir = ep.runDir(RUNS_ROOT, run.id);
  const exec = await executeAnchor({ family: 'firm', anchor: resolved.anchor, config, endpoints: SCOPE });
  const tally = createPreserver(runDir, { runId: run.id }).preserveExecution(exec);
  writeManifest(runDir, buildManifest({ runId: run.id, collectorVersion: run.collectorVersion, apiVersion: run.provenanceContext().apiVersion, family: 'firm', anchor: resolved.anchor, scope: SCOPE, executionStart: null, executionEnd: null }, tally));
  extractRun(runDir);
  run.complete();

  const manifest = readManifest(runDir);

  // Provenance attached to PRESERVED evidence (already present on each raw line).
  const sampleRaw = JSON.parse(fs.readFileSync(path.join(ep.rawDir(runDir), 'firm.address.ndjson'), 'utf8').trim().split('\n')[0]);
  console.log(`  preserved provenance: runId+endpoint+requestUri+timestamp present → ${sampleRaw.runId && sampleRaw.requestUri && sampleRaw.collectionTimestamp ? 'YES ✓' : 'NO ✗'}`);

  // Hash evidence dirs BEFORE writing the additive provenance index.
  const rawBefore = hashDir(ep.rawDir(runDir));
  const structBefore = hashDir(structuredDir(runDir));

  // Additive provenance lineage index.
  const lin = writeLineage(runDir, manifest);
  console.log(`  structured provenance: lineage index written → ${fs.existsSync(lineagePath(runDir)) ? 'YES ✓' : 'NO ✗'} (${lin.lineageRecords} records)`);

  // Evidence unchanged by provenance (additive only).
  const unchanged = hashDir(ep.rawDir(runDir)) === rawBefore && hashDir(structuredDir(runDir)) === structBefore;
  console.log(`  evidence unchanged   : ${unchanged ? 'YES ✓' : 'NO ✗'} (raw/ + structured/ byte-identical)`);

  // End-to-end lineage example.
  const oneStructured = JSON.parse(fs.readFileSync(path.join(structuredDir(runDir), 'firm.address.ndjson'), 'utf8').trim().split('\n')[0]);
  const env = composeEnvelope(manifest, oneStructured, sampleRaw);
  console.log('\n  End-to-end lineage (one record):');
  for (const link of env.chain) console.log('    → ' + link);

  // Integrity verification over ALL structured records.
  const r = verifyRun(runDir);
  console.log(`\n  integrity verified   : ${r.verified}/${r.total} ${r.verified === r.total ? '✓' : '✗'}`);

  // Credential never appears in provenance.
  const lineageText = fs.readFileSync(lineagePath(runDir), 'utf8');
  const noCred = !/x-auth/i.test(lineageText) && !lineageText.includes(config.apiKey);
  console.log(`  credentials absent   : ${noCred ? 'YES ✓' : 'NO ✗'}`);

  const ok = unchanged && r.verified === r.total && noCred && r.total > 0;
  console.log(`\n  Provenance additive: YES   |   Evidence modified: NONE   |   Result: ${ok ? 'PROVENANCE OK ✓' : 'FAILED ✗'}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('provenance-check failed:', e.message); process.exit(1); });
