'use strict';

// report-check.js — Phase 8 verification harness (IMP-FCA-001 §8).
//
// Runs collect → preserve → extract → provenance, then generates the three
// operational reports + discoveries, and verifies consistency with the manifest,
// that evidence is unmodified, and that Phase 6 integrity still passes.
// Concise excerpts only.
//
// Usage: node signal-lab/sources/fca/report-check.js [FRN]

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const { loadConfig, validateConfig } = require('./fca-client');
const { createRun } = require('./collection-run');
const { resolveAnchor } = require('./resolve-anchor');
const { executeAnchor } = require('./endpoint-engine');
const { createPreserver } = require('./preserve');
const { buildManifest, writeManifest } = require('./manifest');
const { extractRun } = require('./extract');
const { writeLineage, verifyRun } = require('./provenance');
const { writeReports, reportsDir } = require('./report');
const { FCA_PROFILE } = require('./fca-report-profile');
const { dependencyParent, dependencyIds } = require('./endpoint-map');
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

  console.log('\n  FCA operational observability check (Phase 8)');
  console.log('  ══════════════════════════════════════════════');

  // pipeline
  const run = createRun({ config }); run.initialise();
  const resolved = await resolveAnchor(frn, { config });
  const runDir = ep.runDir(RUNS_ROOT, run.id);
  const exec = await executeAnchor({ family: 'firm', anchor: resolved.anchor, config, endpoints: SCOPE });
  const tally = createPreserver(runDir, { runId: run.id }).preserveExecution(exec);
  writeManifest(runDir, buildManifest({ runId: run.id, collectorVersion: run.collectorVersion, apiVersion: 'V0.1', family: 'firm', anchor: resolved.anchor, scope: SCOPE, executionStart: new Date().toISOString(), executionEnd: new Date().toISOString() }, tally));
  extractRun(runDir);
  writeLineage(runDir, JSON.parse(fs.readFileSync(ep.manifestPath(runDir), 'utf8')));
  run.complete();

  // compute not-applicable grandchildren (FCA-specific: parent yielded no dep ids)
  const notApplicable = [];
  for (const id of SCOPE) {
    const parent = dependencyParent(id);
    if (!parent) continue;
    const pf = ep.rawFileFor(runDir, parent);
    let depIds = [];
    if (fs.existsSync(pf)) { try { const body = JSON.parse(JSON.parse(fs.readFileSync(pf, 'utf8').trim().split('\n')[0]).rawBody); depIds = dependencyIds(id, body); } catch { /* ignore */ } }
    if (depIds.length === 0) notApplicable.push(id);
  }

  const evidenceBefore = hashDir(ep.rawDir(runDir)) + '|' + hashDir(path.join(runDir, 'structured'));
  const integrity = verifyRun(runDir);
  const { collection, coverage, health, discoveries } = writeReports(runDir, { profile: FCA_PROFILE, integrity, notApplicable });
  const evidenceAfter = hashDir(ep.rawDir(runDir)) + '|' + hashDir(path.join(runDir, 'structured'));

  console.log('\n  Collection report (excerpt):');
  console.log(`    endpoints observed=${collection.endpoints.observed}/${collection.endpoints.expected}  pages=${collection.pagination.totalPages}  structured=${collection.structuredRecords}  provenance=${collection.provenanceRecords}`);
  console.log(`    transport: ${JSON.stringify(collection.transportClassifications)}  retry attempts=${collection.retry.attemptsTotal}`);

  console.log('\n  Coverage report (excerpt):');
  console.log(`    data=${coverage.totals.withData} empty=${coverage.totals.empty} failed=${coverage.totals.failed} not-observed=${coverage.totals.notObserved} not-applicable=${coverage.totals.notApplicable}  coverageComplete=${coverage.coverageComplete}`);

  console.log('\n  Health report (excerpt):');
  console.log(`    retryRate=${health.retry.retryRate} permanentFailures=${health.permanentFailures} resumeEvents=${health.resumeEvents} anomalies=${health.apiAnomalies.length}`);
  console.log(`    manifestConsistent=${health.manifestConsistency.consistent}  integrity=${health.integrity.verified}/${health.integrity.total}`);

  console.log(`\n  Discovery section: ${discoveries.length === 0 ? 'none this run (appears only when new structures observed)' : discoveries.length + ' discovery candidate(s)'}`);
  for (const d of discoveries.slice(0, 3)) console.log(`    - ${d.discoveryId} ${d.endpoint}: ${d.description}`);

  const consistent = collection.artefacts.rawLines === JSON.parse(fs.readFileSync(ep.manifestPath(runDir), 'utf8')).pagesPreserved;
  const unmodified = evidenceBefore === evidenceAfter;
  console.log(`\n  reports written      : ${fs.existsSync(reportsDir(runDir)) ? 'YES ✓' : 'NO ✗'}`);
  console.log(`  consistent w/ manifest: ${consistent ? 'YES ✓' : 'NO ✗'}`);
  console.log(`  evidence unmodified  : ${unmodified ? 'YES ✓' : 'NO ✗'}`);
  console.log(`  integrity (P6)       : ${integrity.verified}/${integrity.total} ${integrity.verified === integrity.total ? '✓' : '✗'}`);

  const ok = consistent && unmodified && integrity.verified === integrity.total && health.manifestConsistency.consistent;
  console.log(`\n  Evidence interpreted: NONE   |   Result: ${ok ? 'OBSERVABILITY OK ✓' : 'FAILED ✗'}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('report-check failed:', e.message); process.exit(1); });
