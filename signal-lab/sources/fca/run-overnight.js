'use strict';

// run-overnight.js — FCA Collection Run 001 (overnight operational run).
//
// OPERATIONAL driver only — composes the validated v1.0 modules. No collector,
// architecture, governance, or constitutional change.
//
// Cohort: the real FCA investment-firms cohort (data/cohort data/investment-firms.csv,
// 2,395 firms with FRNs) — distinct from the search-sampled pilot set.
//
// Per firm: full constitutional scope EXCEPT ultra-high-cardinality endpoints
// (firm.individuals, firm.cf), which are DEFERRED for firms where they exceed a
// normal operational profile (PIL-FCA-002 L-03) so one large firm cannot block the
// cohort. Deferral uses a lightweight SIZING PROBE (one GET reading ResultInfo
// .total_count) — a routing query upstream of collection (same pattern as
// resolve-anchor), recorded in the deferred register; never an evidence failure.
//
// Built for unattended overnight running:
//   - RESUMABLE: re-running skips firms already 'complete' (firms.jsonl), so a
//     sleep/stall/restart never loses or repeats finished work.
//   - PER-FIRM TIMEOUT GUARD: a firm that hangs is recorded and skipped; the cohort
//     keeps moving (a hung firm is retried on a later run).
//
// retry, resume, provenance, reporting, integrity = ON, all unchanged.
//
// Usage:  node run-overnight.js [--limit N]   (default: all firms in the CSV)
//         re-run the same command to resume.

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, validateConfig, buildUrl, getJson } = require('./fca-client');
const { createRun } = require('./collection-run');
const { executeAnchor } = require('./endpoint-engine');
const { createPreserver } = require('./preserve');
const { buildManifest, writeManifest } = require('./manifest');
const { extractRun } = require('./extract');
const { writeLineage, verifyRun } = require('./provenance');
const { writeReports } = require('./report');
const { FCA_PROFILE } = require('./fca-report-profile');
const { orderFor, pathFor, dependencyParent, dependencyIds } = require('./endpoint-map');
const ep = require('./evidence-path');

const PRA_DIR = path.join(__dirname, '../../../../data/cohort data/pra');
const PRA_FILES = [
  { file: 'pra-banks-2606.csv', sector: 'bank' },
  { file: 'pra-insurers-2606.csv', sector: 'insurer' },
  { file: 'pra-credit-unions-2606.csv', sector: 'credit-union' },
  { file: 'pra-building-societies-2606.csv', sector: 'building-society' },
  { file: 'pra-designated-firms.csv', sector: 'designated' },
];
const ROOT = path.join(__dirname, 'runs', 'collection-pra-001');
const LOG = path.join(ROOT, 'collection.log');
const FIRMS_JSONL = path.join(ROOT, 'firms.jsonl');

const THRESHOLD_RECORDS = 500;                 // "normal operational profile" ceiling per mega-endpoint
const MEGA = ['firm.individuals', 'firm.cf'];
const BASE_SCOPE = orderFor('firm').filter((id) => !MEGA.includes(id));
const RETRY = { maxAttempts: 4, baseDelayMs: 800, maxDelayMs: 8000 };
const PER_FIRM_TIMEOUT_MS = 180000;            // hung-firm guard for unattended running

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : null;

function log(msg) { const l = `[${new Date().toISOString()}] ${msg}`; try { fs.appendFileSync(LOG, l + '\n'); } catch { /* ignore */ } process.stdout.write(l + '\n'); }
function dirSize(d) { let t = 0; if (!fs.existsSync(d)) return 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); t += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } return t; }

function readCohort() {
  // Parse the five PRA cohort CSVs (header/disclaimer rows then "Firm Name,FRN,..."),
  // extract {frn, name, sector}, dedupe by FRN across sectors.
  const seen = new Map();
  for (const { file, sector } of PRA_FILES) {
    const p = path.join(PRA_DIR, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cols = line.split(',').map((c) => c.replace(/^﻿/, '').replace(/"/g, '').trim());
      const frn = cols.find((c) => /^\d{6,7}$/.test(c));
      if (!frn) continue; // header/disclaimer/blank rows have no FRN token
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

async function sizeOf(config, frn, endpointId) {
  const r = await getJson(buildUrl(config.baseUrl, pathFor(endpointId, frn)), { email: config.email, apiKey: config.apiKey });
  if (r.errorType !== 'NONE' || !r.body) return { reachable: false, total: null };
  const ri = r.body.ResultInfo || {};
  const total = ri.total_count != null ? parseInt(ri.total_count, 10) : (r.body.Data == null ? 0 : null);
  return { reachable: true, total: Number.isInteger(total) ? total : null };
}

function notApplicable(runDir, scope) {
  const na = [];
  for (const id of scope) { const parent = dependencyParent(id); if (!parent) continue; const pf = ep.rawFileFor(runDir, parent); let deps = []; if (fs.existsSync(pf)) { try { deps = dependencyIds(id, JSON.parse(JSON.parse(fs.readFileSync(pf, 'utf8').trim().split('\n')[0]).rawBody)); } catch { /* ignore */ } } if (deps.length === 0) na.push(id); }
  return na;
}

async function collectFirm(config, frn, name) {
  const runDir = ep.runDir(ROOT, frn);
  fs.rmSync(runDir, { recursive: true, force: true }); // clean (re)collection — no duplicate lines
  const run = createRun({ config, runId: frn }); run.initialise();

  const scope = [...BASE_SCOPE];
  const deferred = [];
  for (const me of MEGA) {
    const s = await sizeOf(config, frn, me);
    if (s.reachable && s.total != null && s.total <= THRESHOLD_RECORDS) scope.push(me);
    else deferred.push({ frn, name, endpoint: me, total_count: s.total, estimatedPages: s.total != null ? Math.ceil(s.total / 20) : null, reason: !s.reachable ? 'size probe unreachable' : (s.total == null ? 'cardinality unknown from probe' : `exceeds operational profile (${s.total} > ${THRESHOLD_RECORDS})`) });
  }
  const orderedScope = orderFor('firm').filter((id) => scope.includes(id));

  const t0 = Date.now();
  const exec = await executeAnchor({ family: 'firm', anchor: frn, config, endpoints: orderedScope, retry: RETRY });
  const tally = createPreserver(runDir, { runId: frn }).preserveExecution(exec);
  writeManifest(runDir, buildManifest({ runId: frn, collectorVersion: run.collectorVersion, apiVersion: 'V0.1', family: 'firm', anchor: frn, scope: orderedScope, executionStart: new Date(t0).toISOString(), executionEnd: new Date().toISOString() }, tally));
  extractRun(runDir);
  writeLineage(runDir, JSON.parse(fs.readFileSync(ep.manifestPath(runDir), 'utf8')));
  const integrity = verifyRun(runDir);
  const reports = writeReports(runDir, { profile: FCA_PROFILE, integrity, notApplicable: notApplicable(runDir, orderedScope) });
  if (deferred.length) fs.writeFileSync(path.join(runDir, 'deferred.json'), JSON.stringify(deferred, null, 2));
  run.complete();

  return { frn, name, status: 'complete', durationMs: Date.now() - t0, megaCollected: MEGA.filter((m) => orderedScope.includes(m)), deferred,
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
  log(`FCA Collection Run 001 (PRA) — cohort ${cohort.length} firms; already complete ${completed.size}; to do ${todo.length}; mega defer >${THRESHOLD_RECORDS} records`);

  const t0 = Date.now();
  let done = 0; let deferrals = 0; let timeouts = 0; let errors = 0;
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i];
    let rec;
    try {
      const r = await withTimeout(collectFirm(config, c.frn, c.name), PER_FIRM_TIMEOUT_MS);
      if (r && r.__timeout) { rec = { frn: c.frn, name: c.name, status: 'timeout' }; timeouts++; }
      else { rec = r; done++; deferrals += r.deferred.length; }
    } catch (e) { rec = { frn: c.frn, name: c.name, status: 'error', error: e.message }; errors++; }
    fs.appendFileSync(FIRMS_JSONL, JSON.stringify(rec) + '\n');
    if ((i + 1) % 25 === 0 || rec.status !== 'complete') {
      const el = (Date.now() - t0) / 1000;
      log(`[${i + 1}/${todo.length}] ${c.frn} ${rec.status}${rec.deferred && rec.deferred.length ? ' deferred=' + rec.deferred.length : ''} | done=${done} timeout=${timeouts} err=${errors} | ${el.toFixed(0)}s elapsed (${(el / (i + 1)).toFixed(1)}s/firm)`);
    }
  }

  // Aggregate everything completed so far (across any resumed runs) from firms.jsonl.
  const all = fs.readFileSync(FIRMS_JSONL, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const complete = all.filter((f) => f.status === 'complete');
  const register = [];
  for (const f of complete) for (const d of (f.deferred || [])) register.push(d);
  const agg = {
    cohort: cohort.length, complete: complete.length, partialWithDeferrals: complete.filter((f) => (f.deferred || []).length).length,
    fullScope: complete.filter((f) => !(f.deferred || []).length).length,
    timeouts: all.filter((f) => f.status === 'timeout').length, errors: all.filter((f) => f.status === 'error').length,
    pages: complete.reduce((n, f) => n + (f.pages || 0), 0), structured: complete.reduce((n, f) => n + (f.structured || 0), 0),
    integrityOk: complete.filter((f) => f.integrity && f.integrity.ok).length, deferrals: register.length,
    sizeBytes: complete.reduce((n, f) => n + (f.sizeBytes || 0), 0),
  };
  fs.writeFileSync(path.join(ROOT, 'collection-summary.json'), JSON.stringify({ run: 'COL-FCA-001', date: new Date().toISOString(), thresholdRecords: THRESHOLD_RECORDS, baseScope: BASE_SCOPE, megaEndpoints: MEGA, aggregate: agg }, null, 2));
  fs.writeFileSync(path.join(ROOT, 'deferred-register.json'), JSON.stringify(register, null, 2));

  log('── COLLECTION RUN 001 (this session) COMPLETE ──');
  log(`complete ${agg.complete}/${cohort.length} | full-scope ${agg.fullScope} | partial(deferred) ${agg.partialWithDeferrals} | timeouts ${agg.timeouts} | errors ${agg.errors}`);
  log(`pages ${agg.pages} | structured ${agg.structured} | integrity-ok firms ${agg.integrityOk}/${agg.complete} | deferrals ${agg.deferrals}`);
  log(`runtime ${((Date.now() - t0) / 60000).toFixed(1)} min | storage ${(agg.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  log('summary: runs/collection-001/collection-summary.json | register: runs/collection-001/deferred-register.json');
}

main().catch((e) => { try { fs.appendFileSync(LOG, `FATAL ${e.stack || e.message}\n`); } catch {} console.error('collection run failed:', e.message); process.exit(1); });
