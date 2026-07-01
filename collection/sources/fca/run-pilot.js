'use strict';

// run-pilot.js — operational pilot driver (IMP-FCA-001 §10). NOT new architecture:
// it composes the accepted v1.0 modules (run → resolve → engine → preserve →
// extract → provenance → resilience → report) to run a real cohort and measure.
//
// Production settings: retry, resume, reporting, provenance, integrity all ON.
// One firm is deliberately interrupted-and-resumed to exercise recovery live.
// Observe only — no optimisation, no architectural change.

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, validateConfig, buildUrl, getJson } = require('./fca-client');
const { createRun } = require('./collection-run');
const { resolveAnchor } = require('./resolve-anchor');
const { executeAnchor } = require('./endpoint-engine');
const { createPreserver } = require('./preserve');
const { buildManifest, writeManifest } = require('./manifest');
const { extractRun } = require('./extract');
const { writeLineage, verifyRun } = require('./provenance');
const { recoverRun } = require('./recovery');
const { writeReports } = require('./report');
const { FCA_PROFILE } = require('./fca-report-profile');
const { dependencyParent, dependencyIds } = require('./endpoint-map');
const ep = require('./evidence-path');

const PILOT_ROOT = path.join(__dirname, 'runs', 'pilot-001');
const SCOPE = ['firm', 'firm.names', 'firm.address', 'firm.permissions', 'firm.requirements', 'firm.requirements.investmentTypes', 'firm.ar', 'firm.regulators', 'firm.disciplinaryHistory', 'firm.waivers', 'firm.exclusions', 'firm.passports', 'firm.passports.permission'];
const PARTIAL = ['firm', 'firm.address', 'firm.regulators']; // for the interrupt-and-resume firm
const RETRY = { maxAttempts: 4, baseDelayMs: 800, maxDelayMs: 8000 };
const TARGET = 25;
const INTERRUPT_INDEX = 12; // the 13th firm is collected partially then resumed

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}
function subSize(runDir, sub) { return dirSize(path.join(runDir, sub)); }

// Build a realistic, non-cherry-picked cohort by sampling the register search surface.
async function buildCohort(config) {
  const terms = ['wealth management', 'financial planning', 'capital', 'insurance services',
    'investment management', 'mortgage advice', 'asset management', 'independent financial',
    'securities', 'payments', 'advisory', 'partners', 'consulting', 'brokers', 'fund',
    'trading', 'pensions', 'credit', 'finance limited', 'group'];
  const found = new Map(); // frn -> name
  for (const term of terms) {
    if (found.size >= TARGET) break;
    const r = await getJson(buildUrl(config.baseUrl, `/Search?q=${encodeURIComponent(term)}&type=firm`), { email: config.email, apiKey: config.apiKey });
    const data = (r.body && Array.isArray(r.body.Data)) ? r.body.Data : [];
    let perTerm = 0;
    for (const h of data) {
      if (found.size >= TARGET || perTerm >= 8) break;
      const frn = h['Reference Number'];
      const name = String(h.Name || '');
      if (!frn || /clone|not authorised|unauthorised/i.test(name)) continue;
      if (!found.has(frn)) { found.set(frn, name); perTerm++; }
    }
  }
  return [...found.entries()].slice(0, TARGET).map(([frn, name]) => ({ frn, name }));
}

function collectFromPreservedAttempts(runDir) {
  // Aggregate true HTTP request counts + status distributions from preserved lines.
  const m = { pages: 0, requests: 0, http: {}, fsr: {}, transport: {}, transient: 0, permanent: 0, rate429: 0 };
  const rDir = ep.rawDir(runDir);
  if (!fs.existsSync(rDir)) return m;
  for (const f of fs.readdirSync(rDir).filter((x) => x.endsWith('.ndjson'))) {
    for (const line of fs.readFileSync(path.join(rDir, f), 'utf8').split('\n').filter(Boolean)) {
      let ln; try { ln = JSON.parse(line); } catch { continue; }
      m.pages++;
      const attempts = Array.isArray(ln.attempts) ? ln.attempts : [{ outcome: ln.transport === 'NONE' ? 'success' : 'failure', httpStatus: ln.httpStatus, transport: ln.transport }];
      for (const a of attempts) {
        m.requests++;
        m.transport[a.transport] = (m.transport[a.transport] || 0) + 1;
        if (a.outcome === 'transient') m.transient++;
        if (a.outcome === 'permanent') m.permanent++;
        if (a.transport === 'RATE_LIMITED' || a.httpStatus === 429) m.rate429++;
        if (a.httpStatus != null) m.http[a.httpStatus] = (m.http[a.httpStatus] || 0) + 1;
      }
      const status = ln.fcaEnvelope ? ln.fcaEnvelope.status : null;
      if (status) m.fsr[status] = (m.fsr[status] || 0) + 1;
    }
  }
  return m;
}

function notApplicableGrandchildren(runDir) {
  const na = [];
  for (const id of SCOPE) {
    const parent = dependencyParent(id);
    if (!parent) continue;
    const pf = ep.rawFileFor(runDir, parent);
    let deps = [];
    if (fs.existsSync(pf)) { try { deps = dependencyIds(id, JSON.parse(JSON.parse(fs.readFileSync(pf, 'utf8').trim().split('\n')[0]).rawBody)); } catch { /* ignore */ } }
    if (deps.length === 0) na.push(id);
  }
  return na;
}

async function collectFirm(config, frn, idx) {
  const runDir = ep.runDir(PILOT_ROOT, frn);
  const run = createRun({ config, runId: frn });
  run.initialise();
  const t0 = Date.now();
  let resumed = false;

  if (idx === INTERRUPT_INDEX) {
    // Deliberate interruption: collect a partial scope, persist manifest declaring FULL scope, then recover.
    const partial = await executeAnchor({ family: 'firm', anchor: frn, config, endpoints: PARTIAL, retry: RETRY });
    const tally = createPreserver(runDir, { runId: frn }).preserveExecution(partial);
    writeManifest(runDir, buildManifest({ runId: frn, collectorVersion: run.collectorVersion, apiVersion: 'V0.1', family: 'firm', anchor: frn, scope: SCOPE, executionStart: new Date(t0).toISOString(), executionEnd: null }, tally));
    await recoverRun(runDir, { config, retry: RETRY });
    resumed = true;
  } else {
    const exec = await executeAnchor({ family: 'firm', anchor: frn, config, endpoints: SCOPE, retry: RETRY });
    const tally = createPreserver(runDir, { runId: frn }).preserveExecution(exec);
    writeManifest(runDir, buildManifest({ runId: frn, collectorVersion: run.collectorVersion, apiVersion: 'V0.1', family: 'firm', anchor: frn, scope: SCOPE, executionStart: new Date(t0).toISOString(), executionEnd: new Date().toISOString() }, tally));
  }

  extractRun(runDir);
  writeLineage(runDir, JSON.parse(fs.readFileSync(ep.manifestPath(runDir), 'utf8')));
  const integrity = verifyRun(runDir);
  const reports = writeReports(runDir, { profile: FCA_PROFILE, integrity, notApplicable: notApplicableGrandchildren(runDir) });
  run.complete();
  const durationMs = Date.now() - t0;

  const req = collectFromPreservedAttempts(runDir);
  return {
    frn, resumed, durationMs,
    ...req,
    structured: reports.collection.structuredRecords,
    provenance: reports.collection.provenanceRecords,
    coverageComplete: reports.coverage.coverageComplete,
    integrity: { verified: integrity.verified, total: integrity.total, ok: integrity.verified === integrity.total },
    discoveries: reports.discoveries.length,
    size: { raw: subSize(runDir, 'raw'), structured: subSize(runDir, 'structured'), provenance: subSize(runDir, 'provenance'), reports: subSize(runDir, 'reports'), total: dirSize(runDir) },
  };
}

async function main() {
  const config = loadConfig();
  const v = validateConfig(config);
  if (!v.ok) { console.error('Config invalid:', v.errors.join('; ')); process.exit(2); }
  fs.mkdirSync(PILOT_ROOT, { recursive: true });

  console.log('\n  FCA Reference Collector v1.0 — Pilot 001 (25 firms)');
  console.log('  ════════════════════════════════════════════════════');
  console.log('  building cohort from the register search surface…');
  const cohort = await buildCohort(config);
  console.log(`  cohort: ${cohort.length} firms\n`);

  const pilotT0 = Date.now();
  const firms = [];
  for (let i = 0; i < cohort.length; i++) {
    const c = cohort[i];
    try {
      const r = await collectFirm(config, c.frn, i);
      firms.push({ ...c, status: 'complete', ...r });
      process.stdout.write(`  [${String(i + 1).padStart(2)}/${cohort.length}] ${c.frn} ${r.resumed ? '(resumed) ' : ''}pages=${r.pages} req=${r.requests} 429=${r.rate429} integrity=${r.integrity.verified}/${r.integrity.total} ${Math.round(r.durationMs)}ms\n`);
    } catch (e) {
      firms.push({ ...c, status: 'error', error: e.message });
      process.stdout.write(`  [${String(i + 1).padStart(2)}/${cohort.length}] ${c.frn} ERROR: ${e.message}\n`);
    }
  }
  const pilotDurationMs = Date.now() - pilotT0;

  // Aggregate
  const done = firms.filter((f) => f.status === 'complete');
  const agg = { firmsTotal: cohort.length, firmsComplete: done.length, firmsErrored: firms.length - done.length,
    pages: 0, requests: 0, structured: 0, provenance: 0, transient: 0, permanent: 0, rate429: 0,
    http: {}, fsr: {}, transport: {}, discoveries: 0, integrityFirmsOk: 0, resumedFirms: 0,
    size: { raw: 0, structured: 0, provenance: 0, reports: 0, total: 0 } };
  for (const f of done) {
    agg.pages += f.pages; agg.requests += f.requests; agg.structured += f.structured; agg.provenance += f.provenance;
    agg.transient += f.transient; agg.permanent += f.permanent; agg.rate429 += f.rate429;
    agg.discoveries += f.discoveries; if (f.integrity.ok) agg.integrityFirmsOk++; if (f.resumed) agg.resumedFirms++;
    for (const k of Object.keys(f.http)) agg.http[k] = (agg.http[k] || 0) + f.http[k];
    for (const k of Object.keys(f.fsr)) agg.fsr[k] = (agg.fsr[k] || 0) + f.fsr[k];
    for (const k of Object.keys(f.transport)) agg.transport[k] = (agg.transport[k] || 0) + f.transport[k];
    for (const k of Object.keys(agg.size)) agg.size[k] += f.size[k];
  }
  const metrics = {
    pilot: 'PIL-FCA-001', date: new Date().toISOString(), scope: SCOPE, retry: RETRY,
    runtime: { totalMs: pilotDurationMs, perFirmMs: done.length ? Math.round(pilotDurationMs / done.length) : null,
      perRequestMs: agg.requests ? Math.round(pilotDurationMs / agg.requests) : null,
      requestsPerSecond: pilotDurationMs ? +(agg.requests / (pilotDurationMs / 1000)).toFixed(2) : null },
    aggregate: agg,
    firms,
  };
  fs.writeFileSync(path.join(PILOT_ROOT, 'pilot-metrics.json'), JSON.stringify(metrics, null, 2));

  console.log('\n  ── Aggregate ──');
  console.log(`  firms complete    : ${agg.firmsComplete}/${cohort.length}  (errored ${agg.firmsErrored}, resumed ${agg.resumedFirms})`);
  console.log(`  pages preserved   : ${agg.pages}   HTTP requests: ${agg.requests}   429s: ${agg.rate429}`);
  console.log(`  structured        : ${agg.structured}   provenance: ${agg.provenance}   discoveries: ${agg.discoveries}`);
  console.log(`  integrity         : ${agg.integrityFirmsOk}/${agg.firmsComplete} firms fully verified`);
  console.log(`  transport dist    : ${JSON.stringify(agg.transport)}`);
  console.log(`  HTTP dist         : ${JSON.stringify(agg.http)}`);
  console.log(`  runtime           : total ${(pilotDurationMs / 1000).toFixed(1)}s  perFirm ${metrics.runtime.perFirmMs}ms  perReq ${metrics.runtime.perRequestMs}ms  RPS ${metrics.runtime.requestsPerSecond}`);
  console.log(`  storage           : total ${(agg.size.total / 1024).toFixed(1)} KB  perFirm ${done.length ? (agg.size.total / done.length / 1024).toFixed(1) : 0} KB  (raw ${(agg.size.raw / 1024).toFixed(1)} / struct ${(agg.size.structured / 1024).toFixed(1)} / prov ${(agg.size.provenance / 1024).toFixed(1)} / reports ${(agg.size.reports / 1024).toFixed(1)})`);
  console.log(`\n  metrics written: ${path.relative(process.cwd(), path.join(PILOT_ROOT, 'pilot-metrics.json'))}\n`);
}

main().catch((e) => { console.error('pilot failed:', e.message); process.exit(1); });
