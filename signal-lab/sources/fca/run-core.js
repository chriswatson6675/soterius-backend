'use strict';

// run-core.js — FCA CORE production collection runner.
//
// OPERATIONAL driver only — composes the validated v1.0 modules at the CORE
// collection profile (collection-profiles.js → `firm`, `firm.address`). It is a lean
// sibling of run-overnight.js for continuous routine operation: it collects ONLY the
// two endpoints the current platform consumes (firm identity + declared website).
//
// Because the Core scope contains no mega and no grandchild endpoints, this runner
// executes:
//   - NO mega endpoints (firm.individuals / firm.cf),
//   - NO grandchild traversal (requirements.investmentTypes / passports.permission),
//   - NO mega SIZING PROBES — the sizeOf() probe exists only in run-overnight.js and
//     is never imported or invoked here. Core makes exactly the endpoint requests in
//     CORE_SCOPE and nothing else.
//
// No collector, engine, architecture, or governance change. The full-scope runners
// (run-overnight / run-pilot / run-largefirm) are untouched and remain the full
// profile. retry, resume, preserve, extract, provenance, integrity, reporting are ON
// and unchanged — the SAME module calls run-overnight.js makes, minus mega/deferral.
//
// Usage:  node run-core.js [--limit N]   (default: all PRA cohort firms; resumable —
//         re-run to resume; firms already 'complete' in firms.jsonl are skipped.)

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, validateConfig } = require('./fca-client');
const { createRun } = require('./collection-run');
const { executeAnchor } = require('./endpoint-engine');
const { createPreserver } = require('./preserve');
const { buildManifest, writeManifest } = require('./manifest');
const { extractRun } = require('./extract');
const { writeLineage, verifyRun } = require('./provenance');
const { writeReports } = require('./report');
const { FCA_PROFILE } = require('./fca-report-profile');
const { endpointsFor } = require('./collection-profiles');
const ep = require('./evidence-path');

const CORE_SCOPE = endpointsFor('core');          // ['firm', 'firm.address']
const PRA_DIR = path.join(__dirname, '../../../../data/cohort data/pra');
const PRA_FILES = [
  { file: 'pra-banks-2606.csv', sector: 'bank' },
  { file: 'pra-insurers-2606.csv', sector: 'insurer' },
  { file: 'pra-credit-unions-2606.csv', sector: 'credit-union' },
  { file: 'pra-building-societies-2606.csv', sector: 'building-society' },
  { file: 'pra-designated-firms.csv', sector: 'designated' },
];
const ROOT = path.join(__dirname, 'runs', 'collection-core-001');
const LOG = path.join(ROOT, 'collection.log');
const FIRMS_JSONL = path.join(ROOT, 'firms.jsonl');
const RETRY = { maxAttempts: 4, baseDelayMs: 800, maxDelayMs: 8000 };
const PER_FIRM_TIMEOUT_MS = 60000;                // Core is ~2 requests/firm; generous hung-firm guard

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : null;

function log(msg) { const l = `[${new Date().toISOString()}] ${msg}`; try { fs.appendFileSync(LOG, l + '\n'); } catch { /* ignore */ } process.stdout.write(l + '\n'); }
function dirSize(d) { let t = 0; if (!fs.existsSync(d)) return 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); t += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } return t; }

// Same PRA cohort reader as run-overnight.js (kept local so the frozen full-scope
// runner is not modified). Parses the five PRA CSVs, extracts {frn, name, sector},
// dedupes by FRN across sectors.
function readCohort() {
  const seen = new Map();
  for (const { file, sector } of PRA_FILES) {
    const p = path.join(PRA_DIR, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cols = line.split(',').map((c) => c.replace(/^﻿/, '').replace(/"/g, '').trim());
      const frn = cols.find((c) => /^\d{6,7}$/.test(c));
      if (!frn) continue;
      const name = (cols[0] && !/^\d{6,7}$/.test(cols[0])) ? cols[0] : (cols[1] || '');
      if (!seen.has(frn)) seen.set(frn, { frn, name, sector });
    }
  }
  return [...seen.values()];
}

function loadCompleted() {
  const done = new Set();
  if (!fs.existsSync(FIRMS_JSONL)) return done;
  for (const line of fs.readFileSync(FIRMS_JSONL, 'utf8').split('\n').filter(Boolean)) {
    try { const r = JSON.parse(line); if (r.status === 'complete') done.add(r.frn); } catch { /* ignore */ }
  }
  return done;
}

/**
 * Collect ONE firm at the Core profile. Composes the exact same module pipeline as
 * run-overnight.js (engine → preserve → manifest → extract → provenance → integrity
 * → reports), but only over CORE_SCOPE — no mega, no grandchildren, no sizing probe.
 *
 * @param {Object} config        - fca-client.loadConfig() shape
 * @param {string} frn
 * @param {string} [name]
 * @param {Object} [opts]        - { root, _fetch } — root overrides the run root;
 *                                 _fetch is an injectable transport (tests).
 */
async function collectCoreFirm(config, frn, name, opts = {}) {
  const root = opts.root ?? ROOT;
  const runDir = ep.runDir(root, frn);
  fs.rmSync(runDir, { recursive: true, force: true }); // clean (re)collection — no duplicate lines
  const run = createRun({ config, runId: frn }); run.initialise();

  const t0 = Date.now();
  const exec = await executeAnchor({ family: 'firm', anchor: frn, config, endpoints: CORE_SCOPE, retry: RETRY, _fetch: opts._fetch });
  const tally = createPreserver(runDir, { runId: frn }).preserveExecution(exec);
  writeManifest(runDir, buildManifest({ runId: frn, collectorVersion: run.collectorVersion, apiVersion: 'V0.1', family: 'firm', anchor: frn, scope: CORE_SCOPE, executionStart: new Date(t0).toISOString(), executionEnd: new Date().toISOString() }, tally));
  extractRun(runDir);
  writeLineage(runDir, JSON.parse(fs.readFileSync(ep.manifestPath(runDir), 'utf8')));
  const integrity = verifyRun(runDir);
  // Core scope has no grandchildren, so there are no not-applicable grandchild endpoints.
  const reports = writeReports(runDir, { profile: FCA_PROFILE, integrity, notApplicable: [] });
  run.complete();

  return { frn, name, status: 'complete', durationMs: Date.now() - t0, order: exec.order,
    pages: tally.pagesPreserved, structured: reports.collection.structuredRecords,
    integrity: { verified: integrity.verified, total: integrity.total, ok: integrity.verified === integrity.total },
    coverageComplete: reports.coverage.coverageComplete, sizeBytes: dirSize(runDir) };
}

function withTimeout(promise, ms) {
  let to; const guard = new Promise((res) => { to = setTimeout(() => res({ __timeout: true }), ms); });
  return Promise.race([promise.finally(() => clearTimeout(to)), guard]);
}

async function main() {
  const config = loadConfig();
  const v = validateConfig(config);
  if (!v.ok) { console.error('Config invalid:', v.errors.join('; ')); process.exit(2); }
  fs.mkdirSync(ROOT, { recursive: true }); // NB: NOT wiped — resume-safe

  let cohort = readCohort();
  if (LIMIT) cohort = cohort.slice(0, LIMIT);
  const completed = loadCompleted();
  const todo = cohort.filter((c) => !completed.has(c.frn));
  log(`FCA CORE Collection — profile=core scope=[${CORE_SCOPE.join(', ')}] | cohort ${cohort.length} firms; already complete ${completed.size}; to do ${todo.length}`);

  const t0 = Date.now();
  let done = 0; let timeouts = 0; let errors = 0;
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i];
    let rec;
    try {
      const r = await withTimeout(collectCoreFirm(config, c.frn, c.name), PER_FIRM_TIMEOUT_MS);
      if (r && r.__timeout) { rec = { frn: c.frn, name: c.name, status: 'timeout' }; timeouts++; }
      else { rec = r; done++; }
    } catch (e) { rec = { frn: c.frn, name: c.name, status: 'error', error: e.message }; errors++; }
    fs.appendFileSync(FIRMS_JSONL, JSON.stringify(rec) + '\n');
    if ((i + 1) % 50 === 0 || rec.status !== 'complete') {
      const el = (Date.now() - t0) / 1000;
      log(`[${i + 1}/${todo.length}] ${c.frn} ${rec.status} | done=${done} timeout=${timeouts} err=${errors} | ${el.toFixed(0)}s elapsed (${(el / (i + 1)).toFixed(2)}s/firm)`);
    }
  }

  const all = fs.readFileSync(FIRMS_JSONL, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const complete = all.filter((f) => f.status === 'complete');
  const agg = {
    cohort: cohort.length, complete: complete.length,
    timeouts: all.filter((f) => f.status === 'timeout').length, errors: all.filter((f) => f.status === 'error').length,
    pages: complete.reduce((n, f) => n + (f.pages || 0), 0), structured: complete.reduce((n, f) => n + (f.structured || 0), 0),
    integrityOk: complete.filter((f) => f.integrity && f.integrity.ok).length, sizeBytes: complete.reduce((n, f) => n + (f.sizeBytes || 0), 0),
  };
  fs.writeFileSync(path.join(ROOT, 'collection-summary.json'), JSON.stringify({ run: 'COL-FCA-CORE-001', profile: 'core', scope: CORE_SCOPE, date: new Date().toISOString(), aggregate: agg }, null, 2));

  log('── CORE COLLECTION (this session) COMPLETE ──');
  log(`complete ${agg.complete}/${cohort.length} | timeouts ${agg.timeouts} | errors ${agg.errors}`);
  log(`pages ${agg.pages} | structured ${agg.structured} | integrity-ok firms ${agg.integrityOk}/${agg.complete}`);
  log(`runtime ${((Date.now() - t0) / 60000).toFixed(1)} min | storage ${(agg.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
}

module.exports = { collectCoreFirm, readCohort, loadCompleted, CORE_SCOPE, ROOT };

// Operational entry point — only when run directly (so the module is importable in tests).
if (require.main === module) {
  main().catch((e) => { try { fs.appendFileSync(LOG, `FATAL ${e.stack || e.message}\n`); } catch {} console.error('core collection run failed:', e.message); process.exit(1); });
}
