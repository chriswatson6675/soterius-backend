'use strict';

// run-largefirm.js — large-firm deep validation at FULL constitutional scope.
// IMP-FCA-001 §10 / large-firm validation. Composes accepted v1.0 modules only;
// no optimisation, no scope reduction. Full firm family INCLUDING individuals + CF
// with full pagination. Resume is exercised at scale: a capped first pass
// (interruption) then recoverRun continues the giant paginated endpoints to
// completion (same total requests, genuine continuation). Observe & measure only.

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
const { recoverRun } = require('./recovery');
const { writeReports } = require('./report');
const { FCA_PROFILE } = require('./fca-report-profile');
const { orderFor, dependencyParent, dependencyIds } = require('./endpoint-map');
const ep = require('./evidence-path');

const ARGS = process.argv.slice(2);
const RESUME = ARGS.includes('--resume');
const FRN = (ARGS.find((a) => !a.startsWith('--'))) || '122702';
const RUN_ROOT = path.join(__dirname, 'runs');
const RUN_ID = `largefirm-${FRN}`;
const RUN_DIR = ep.runDir(RUN_ROOT, RUN_ID);
const FULL_SCOPE = orderFor('firm');                 // ALL 15 firm endpoints incl individuals + cf
const PARTIAL_CAP = 5;                                // first pass caps pagination → forces interruption
const RETRY = { maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 30000 };
const LOG = path.join(RUN_DIR, 'large-progress.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG, line + '\n');
  process.stdout.write(line + '\n');
}
function dirSize(dir) { let t = 0; if (!fs.existsSync(dir)) return 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); t += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } return t; }
function perEndpointPages(runDir) {
  const out = {}; const rDir = ep.rawDir(runDir);
  for (const f of fs.readdirSync(rDir).filter((x) => x.endsWith('.ndjson'))) out[f.replace(/\.ndjson$/, '')] = fs.readFileSync(path.join(rDir, f), 'utf8').split('\n').filter(Boolean).length;
  return out;
}
function requestStats(runDir) {
  const m = { pages: 0, requests: 0, http: {}, transport: {}, transient: 0, permanent: 0, rate429: 0 };
  const rDir = ep.rawDir(runDir);
  for (const f of fs.readdirSync(rDir).filter((x) => x.endsWith('.ndjson'))) {
    for (const line of fs.readFileSync(path.join(rDir, f), 'utf8').split('\n').filter(Boolean)) {
      let ln; try { ln = JSON.parse(line); } catch { continue; }
      m.pages++;
      const att = Array.isArray(ln.attempts) ? ln.attempts : [{ outcome: ln.transport === 'NONE' ? 'success' : 'failure', httpStatus: ln.httpStatus, transport: ln.transport }];
      for (const a of att) { m.requests++; m.transport[a.transport] = (m.transport[a.transport] || 0) + 1; if (a.outcome === 'transient') m.transient++; if (a.outcome === 'permanent') m.permanent++; if (a.transport === 'RATE_LIMITED' || a.httpStatus === 429) m.rate429++; if (a.httpStatus != null) m.http[a.httpStatus] = (m.http[a.httpStatus] || 0) + 1; }
    }
  }
  return m;
}
function notApplicable(runDir) {
  const na = [];
  for (const id of FULL_SCOPE) { const parent = dependencyParent(id); if (!parent) continue; const pf = ep.rawFileFor(runDir, parent); let deps = []; if (fs.existsSync(pf)) { try { deps = dependencyIds(id, JSON.parse(JSON.parse(fs.readFileSync(pf, 'utf8').trim().split('\n')[0]).rawBody)); } catch { /* ignore */ } } if (deps.length === 0) na.push(id); }
  return na;
}

async function main() {
  const config = loadConfig();
  const v = validateConfig(config);
  if (!v.ok) { console.error('Config invalid:', v.errors.join('; ')); process.exit(2); }

  const run = createRun({ config, runId: RUN_ID }); run.initialise();
  let tCollect0; let rec;
  let tally = { pagesPreserved: 0 };

  if (RESUME && fs.existsSync(RUN_DIR)) {
    // RESUME MODE: continue an interrupted run from preserved state — never wipe.
    // Ensure a full-scope manifest exists (if the prior run died before writing one).
    if (!fs.existsSync(ep.manifestPath(RUN_DIR))) {
      writeManifest(RUN_DIR, buildManifest({ runId: RUN_ID, collectorVersion: run.collectorVersion, apiVersion: 'V0.1', family: 'firm', anchor: FRN, scope: FULL_SCOPE, executionStart: new Date().toISOString(), executionEnd: null }, { endpointsAttempted: 0, endpointsPreserved: 0, pagesPreserved: 0, transportErrors: 0, artefacts: [] }));
    }
    log(`RESUME mode FRN=${FRN}: continuing from preserved state (no wipe)`);
    tCollect0 = Date.now();
    rec = { summary: { continued: [], observed: [], skipped: [], newPages: 0 } };
    for (let i = 0; i < 10; i++) {
      const r = await recoverRun(RUN_DIR, { config, retry: RETRY });
      rec.summary.continued.push(...r.summary.continued); rec.summary.observed.push(...r.summary.observed);
      rec.summary.skipped.push(...r.summary.skipped); rec.summary.newPages += r.summary.newPages;
      log(`resume iter ${i + 1}: continued=${r.summary.continued.length} observed=${r.summary.observed.length} newPages=${r.summary.newPages} complete=${r.alreadyComplete}`);
      if (r.alreadyComplete || r.summary.newPages === 0) break;
    }
  } else {
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
    fs.mkdirSync(RUN_DIR, { recursive: true });
    log(`large-firm deep validation FRN=${FRN} scope=${FULL_SCOPE.length} endpoints (incl individuals + cf), full pagination`);

    // --- Pass 1: capped first pass (deliberate interruption of the giant paginated endpoints) ---
    tCollect0 = Date.now();
    log(`pass 1: capped collection (maxPages=${PARTIAL_CAP}) — interrupts individuals/cf mid-pagination`);
    const partial = await executeAnchor({ family: 'firm', anchor: FRN, config, endpoints: FULL_SCOPE, retry: RETRY, maxPagesPerEndpoint: PARTIAL_CAP });
    tally = createPreserver(RUN_DIR, { runId: RUN_ID }).preserveExecution(partial);
    writeManifest(RUN_DIR, buildManifest({ runId: RUN_ID, collectorVersion: run.collectorVersion, apiVersion: 'V0.1', family: 'firm', anchor: FRN, scope: FULL_SCOPE, executionStart: new Date(tCollect0).toISOString(), executionEnd: null }, tally));
    log(`pass 1 done: pages=${tally.pagesPreserved} (capped)`);

    // --- Pass 2: resume — continue the interrupted paginated endpoints to completion ---
    log('pass 2: recoverRun — resuming pagination from saved Next to completion (full scope)');
    rec = await recoverRun(RUN_DIR, { config, retry: RETRY });
    log(`resume done: continued=${rec.summary.continued.length} observed=${rec.summary.observed.length} skipped=${rec.summary.skipped.length} newPages=${rec.summary.newPages}`);
  }
  const tCollect1 = Date.now();

  // --- Extract / provenance / integrity / reports ---
  const tEx0 = Date.now();
  const ex = extractRun(RUN_DIR);
  const tEx1 = Date.now();
  writeLineage(RUN_DIR, JSON.parse(fs.readFileSync(ep.manifestPath(RUN_DIR), 'utf8')));
  const tLin1 = Date.now();
  log(`extract: ${ex.tally.structuredRecords} structured (${tEx1 - tEx0}ms); lineage written (${tLin1 - tEx1}ms)`);
  const tV0 = Date.now();
  const integrity = verifyRun(RUN_DIR);
  const tV1 = Date.now();
  log(`integrity: ${integrity.verified}/${integrity.total} (${tV1 - tV0}ms)`);
  const reports = writeReports(RUN_DIR, { profile: FCA_PROFILE, integrity, notApplicable: notApplicable(RUN_DIR) });

  // --- Post-run idempotent resume check (state detection at scale) ---
  const rec2 = await recoverRun(RUN_DIR, { config });
  run.complete();

  // --- Metrics ---
  const req = requestStats(RUN_DIR);
  const metrics = {
    validation: 'large-firm-deep', frn: FRN, date: new Date().toISOString(), scope: FULL_SCOPE, retry: RETRY,
    runtime: { collectMs: tCollect1 - tCollect0, extractMs: tEx1 - tEx0, lineageMs: tLin1 - tEx1, verifyMs: tV1 - tV0, totalMs: Date.now() - tCollect0,
      perRequestMs: req.requests ? Math.round((tCollect1 - tCollect0) / req.requests) : null, requestsPerSecond: (tCollect1 - tCollect0) ? +(req.requests / ((tCollect1 - tCollect0) / 1000)).toFixed(2) : null },
    requests: req,
    perEndpointPages: perEndpointPages(RUN_DIR),
    structuredRecords: ex.tally.structuredRecords,
    provenanceRecords: reports.collection.provenanceRecords,
    discoveries: reports.discoveries.length,
    coverageComplete: reports.coverage.coverageComplete,
    integrity: { verified: integrity.verified, total: integrity.total, ok: integrity.verified === integrity.total },
    resume: { interruptedPass1Pages: tally.pagesPreserved, continued: rec.summary.continued, observed: rec.summary.observed.length, resumeNewPages: rec.summary.newPages, idempotentRecheck: { alreadyComplete: rec2.alreadyComplete, newPages: rec2.summary.newPages } },
    storage: { raw: dirSize(path.join(RUN_DIR, 'raw')), structured: dirSize(path.join(RUN_DIR, 'structured')), provenance: dirSize(path.join(RUN_DIR, 'provenance')), reports: dirSize(path.join(RUN_DIR, 'reports')), total: dirSize(RUN_DIR) },
  };
  fs.writeFileSync(path.join(RUN_DIR, 'large-metrics.json'), JSON.stringify(metrics, null, 2));

  log('── SUMMARY ──');
  log(`pages=${req.pages} requests=${req.requests} 429s=${req.rate429} transient=${req.transient} permanent=${req.permanent}`);
  log(`structured=${metrics.structuredRecords} provenance=${metrics.provenanceRecords} discoveries=${metrics.discoveries}`);
  log(`integrity=${integrity.verified}/${integrity.total} resume continued=${rec.summary.continued.length} idempotent=${rec2.alreadyComplete}`);
  log(`runtime collect=${(metrics.runtime.collectMs / 1000).toFixed(1)}s extract=${(metrics.runtime.extractMs / 1000).toFixed(1)}s verify=${(metrics.runtime.verifyMs / 1000).toFixed(1)}s RPS=${metrics.runtime.requestsPerSecond}`);
  log(`storage total=${(metrics.storage.total / 1024 / 1024).toFixed(2)}MB (raw ${(metrics.storage.raw / 1024 / 1024).toFixed(2)} / struct ${(metrics.storage.structured / 1024 / 1024).toFixed(2)} / prov ${(metrics.storage.provenance / 1024 / 1024).toFixed(2)})`);
  log(`DONE — metrics: ${path.join('runs', RUN_ID, 'large-metrics.json')}`);
}

main().catch((e) => { try { fs.appendFileSync(LOG, `FATAL ${e.stack || e.message}\n`); } catch {} console.error('large-firm validation failed:', e.message); process.exit(1); });
