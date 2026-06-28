'use strict';

// run-if001.js — first authoritative Companies House collection against IF-001.
//
// Drives the CCS-COMPHOUSE-001 collector across the IF-001 cohort, preserves the
// observed evidence to an append-only run directory, and writes the first
// collection report. This is the runner layer: it discovers anchors (resolve-anchor),
// invokes observe() per firm (the collector), and performs Preserve (preserve.js).
//
// The collector itself is unchanged and untouched: it observes one anchor and emits.
// Resolution and storage — the two things the collector deliberately does NOT do —
// live here, exactly as the registrar runner derives anchors upstream and persists.
//
// Usage:
//   CH_API_KEY=xxxx node signal-lab/sources/companies-house/run-if001.js [--limit N] [--no-docs] [--resume <runId>]
//
// Required env: CH_API_KEY (free key from developer.company-information.service.gov.uk)
// The cohort is read from signal-lab/if001-full/cohort-manifest.json.

try { require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const collector = require('./companieshouse-collector');
const { createRateManager } = require('./ch-client');
const { resolveCompanyNumber, RESOLUTION } = require('./resolve-anchor');
const { createPreserver } = require('./preserve');
const { buildReport } = require('./report');

const COHORT_PATH = path.join(__dirname, '../../if001-full/cohort-manifest.json');
const RUNS_ROOT = path.join(__dirname, 'runs');
const SCOPE_OBJECTS = ['EO-02', 'EO-03', 'EO-04', 'EO-05', 'EO-07', 'EO-08', 'EO-09'];

function parseArgs(argv) {
  const args = { limit: null, includeDocuments: true, resume: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--no-docs') args.includeDocuments = false;
    else if (argv[i] === '--resume') args.resume = argv[++i];
  }
  return args;
}

async function main() {
  const apiKey = process.env.CH_API_KEY;
  if (!apiKey) {
    console.error('\n  ERROR: CH_API_KEY is required (free key from developer.company-information.service.gov.uk).');
    console.error('  Set it in backend/.env or pass it inline: CH_API_KEY=xxxx node run-if001.js\n');
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));

  const cohort = JSON.parse(fs.readFileSync(COHORT_PATH, 'utf8'));
  const firms = cohort.firms ?? [];
  const targetFirms = args.limit ? firms.slice(0, args.limit) : firms;

  const runId = args.resume ?? randomUUID();
  const runDir = path.join(RUNS_ROOT, runId);
  const startedAt = new Date().toISOString();

  // Resume support: skip firms already preserved (by firm id in coverage/resolution).
  const done = loadCompletedFirmIds(runDir);

  const manifest = {
    runId,
    runDir,
    source: 'companies-house',
    collectorVersion: collector.SURFACE ? '1.0.0' : '1.0.0',
    cohort: { id: cohort.cohort_id, name: cohort.cohort_name, n: cohort.n ?? firms.length },
    targetCount: targetFirms.length,
    scope: { objects: SCOPE_OBJECTS, includeDocuments: args.includeDocuments },
    startedAt,
  };
  const preserver = createPreserver(runDir, manifest);

  const HR = '='.repeat(78);
  console.log(`\n${HR}`);
  console.log(` COMPANIES HOUSE — IF-001 FIRST COLLECTION`);
  console.log(` Cohort   : ${cohort.cohort_id} — ${targetFirms.length} of ${firms.length} firms`);
  console.log(` Run ID   : ${runId}`);
  console.log(` Scope    : ${SCOPE_OBJECTS.join(', ')}${args.includeDocuments ? ' (+EO-06 docs)' : ''}`);
  console.log(` Run dir  : ${runDir}`);
  if (done.size) console.log(` Resuming : ${done.size} firm(s) already preserved — skipping`);
  console.log(HR + '\n');

  const rateManager = createRateManager();
  const deps = { apiKey, client: require('./ch-client'), rateManager };

  let i = 0;
  for (const firm of targetFirms) {
    i++;
    const firmRef = { id: firm.id ?? null, firm_name: firm.firm_name, domain: firm.domain ?? null };
    if (firm.id && done.has(firm.id)) { logLine(i, targetFirms.length, firm, 'SKIP', 'already preserved'); continue; }

    // 1) Resolve firm → anchor (upstream of observation).
    let resolution;
    try {
      resolution = await resolveCompanyNumber(firm, deps);
    } catch (e) {
      resolution = { firm: firmRef, status: RESOLUTION.SEARCH_UNAVAILABLE, reason: e.message, companyNumber: null, candidates: [] };
    }
    preserver.preserveResolution(resolution);

    if (resolution.status !== RESOLUTION.RESOLVED) {
      logLine(i, targetFirms.length, firm, 'NORES', resolution.status);
      continue;
    }

    // 2) Observe the anchor (the collector).
    let result;
    try {
      result = await collector.observe({
        anchor: { type: 'company', value: resolution.companyNumber },
        scope: { objects: SCOPE_OBJECTS, includeDocuments: args.includeDocuments },
        mode: 'targeted-snapshot',
      }, deps);
    } catch (e) {
      // A throw here is a programming/request error, not an observation outcome.
      logLine(i, targetFirms.length, firm, 'THROW', e.message);
      continue;
    }

    // 3) Preserve the observed evidence.
    preserver.preserveObservation(firmRef, result);
    const m = result.metrics;
    const tag = result.coverage.anchorObserved ? 'OK' : 'ANCHOR?';
    logLine(i, targetFirms.length, firm, tag,
      `cn=${resolution.companyNumber} emitted=${m.emitted} abs=${m.observedAbsences} non=${m.nonObservations}`);
  }

  manifest.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 4) Report.
  const { model, markdown } = buildReport(runDir);
  fs.writeFileSync(path.join(runDir, 'report.md'), markdown);
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(model, null, 2));

  console.log(`\n${HR}`);
  console.log(markdown);
  console.log(`\n${HR}`);
  console.log(` Evidence preserved in : ${runDir}`);
  console.log(` Report                : ${path.join(runDir, 'report.md')}`);
  console.log(`${HR}\n`);
}

function loadCompletedFirmIds(runDir) {
  const ids = new Set();
  const cov = path.join(runDir, 'coverage.ndjson');
  const res = path.join(runDir, 'resolution.ndjson');
  for (const f of [cov, res]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      try { const o = JSON.parse(line); const id = o.firm?.id ?? o.firm?.firm_name; if (id) ids.add(id); } catch { /* skip */ }
    }
  }
  return ids;
}

function logLine(i, total, firm, tag, detail) {
  const pct = String(Math.round((i / total) * 100)).padStart(3);
  const name = (firm.firm_name ?? '(no name)').slice(0, 38).padEnd(38);
  console.log(`  [${pct}%] ${tag.padEnd(7)} ${name} ${detail}`);
}

if (require.main === module) {
  main().catch((e) => { console.error('\nFATAL', e); process.exit(1); });
}

module.exports = { main };
