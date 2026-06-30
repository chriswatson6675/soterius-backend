'use strict';

// acquire-fca.js — thin executable that COMPOSES the Population Acquisition Layer and
// runs a real acquisition. Orchestration only: it adds no new abstraction, layer, or
// business rule — it just wires the frozen modules together and prints a summary.
//
//   ledger  ← processing-ledger
//   adapters← fca-adapters (real FCA search / enrich / registry persist)
//   source  ← companies-house-source (a supplied CH Free Company Data Product snapshot)
//   run     ← candidate-source-runner
//
// Usage:
//   node acquire-fca.js --snapshot <path.csv> [--limit N] [--ledger <path>] [--registry <path>]

const path = require('node:path');
try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch { /* optional */ }

const fs = require('node:fs');
const { openLedger } = require('./processing-ledger');
const { createFcaSearch, createFcaEnrich, createRegistryPersist } = require('./fca-adapters');
const { companiesHouseCandidateSource, streamBulkCsv } = require('./companies-house-source');
const { companiesHouseApiCandidateSource } = require('./companies-house-api-source');
const { runCandidateSource } = require('./candidate-source-runner');
const { processCandidate } = require('./candidate-processor');
const { loadCohortIndex, createCohortExclusionFilter, withCohortExclusion } = require('./cohort-exclusion-filter');
const { loadConfig, validateConfig } = require('../sources/fca/fca-client');

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }

/** Thin limit wrapper (composition, not a new layer): yield at most n candidates. */
async function* take(src, n) { let i = 0; for await (const x of src) { if (i >= n) break; i++; yield x; } }

async function main() {
  const snapshot = arg('--snapshot');                  // optional: a CH bulk CSV snapshot
  const limit = arg('--limit') ? parseInt(arg('--limit'), 10) : null;
  const runDir = path.join(__dirname, 'runs', 'fca-acquisition');
  const ledgerPath = arg('--ledger', path.join(runDir, 'ledger.ndjson'));
  const registryPath = arg('--registry', path.join(runDir, 'registry.ndjson'));

  const config = loadConfig();
  const v = validateConfig(config);
  if (!v.ok) { console.error('FCA config invalid:', v.errors.join('; ')); process.exit(2); }

  const ledger = openLedger({ path: ledgerPath });
  const deps = {
    ledger,
    fcaSearch: createFcaSearch({ config }),
    fcaEnrich: createFcaEnrich({ config }),
    persist: createRegistryPersist({ path: registryPath }),
  };

  // Cohort exclusion: skip firms already in the authoritative IF and PRA cohorts,
  // immediately before the Candidate Processor (no FCA/ledger/registry for skips).
  const cohortDir = path.join(__dirname, '../../../data/cohort data');
  const praDir = path.join(cohortDir, 'pra');
  const praPaths = fs.existsSync(praDir) ? fs.readdirSync(praDir).filter((f) => f.endsWith('.csv')).map((f) => path.join(praDir, f)) : [];
  const cohortIndex = loadCohortIndex({ ifPath: path.join(cohortDir, 'investment-firms.csv'), praPaths });
  const filteredProcess = withCohortExclusion(createCohortExclusionFilter(cohortIndex), processCandidate);
  process.stdout.write(`cohort exclusion loaded — IF ${cohortIndex.ifNames.size} names, PRA ${cohortIndex.praNames.size} names\n`);

  // Candidate source: a CH bulk snapshot if supplied, else query CH advanced-search
  // directly by the approved SIC codes (no whole-register download).
  let source; let sourceLabel;
  if (snapshot) {
    const onRow = (n) => { if (n % 1000000 === 0) process.stdout.write(`scanned ${(n / 1000000)}M rows…\n`); };
    source = companiesHouseCandidateSource({ records: streamBulkCsv(snapshot, { onRow }) });
    sourceLabel = `snapshot ${snapshot}`;
  } else {
    const chKey = process.env.CH_API_KEY || process.env.COMPANIES_HOUSE_API_KEY;
    if (!chKey) { console.error('no --snapshot given and no CH_API_KEY/COMPANIES_HOUSE_API_KEY for the by-SIC source'); process.exit(2); }
    source = companiesHouseApiCandidateSource({ apiKey: chKey, log: (m) => process.stdout.write(m + '\n') });
    sourceLabel = 'Companies House advanced-search by approved SIC codes';
  }
  if (limit) source = take(source, limit);

  process.stdout.write(`FCA acquisition starting — source: ${sourceLabel}${limit ? ` (limit ${limit})` : ''}\n`);
  const t0 = Date.now();
  const summary = await runCandidateSource(source, deps, { process: filteredProcess });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const c = summary.counts;
  const n = (k) => c[k] || 0;
  process.stdout.write([
    '',
    'FCA Acquisition Summary',
    `  companies processed : ${summary.processed}`,
    `  skipped (IF cohort) : ${n('skipped_if')}`,
    `  skipped (PRA cohort): ${n('skipped_pra')}`,
    `  acquired            : ${n('acquired')}`,
    `  already claimed     : ${n('already_claimed')}`,
    `  no FCA match        : ${n('no_match')}`,
    `  ambiguous           : ${n('ambiguous')}`,
    `  discarded           : ${n('discarded')}`,
    `  research            : ${n('research')}`,
    `  failed              : ${n('failed')}`,
    `  elapsed             : ${elapsed}s`,
    summary.stopped ? `  STOPPED on error    : ${summary.error}` : '',
    `  ledger              : ${ledgerPath}`,
    `  registry            : ${registryPath}`,
    '',
  ].filter((l) => l !== '').join('\n') + '\n');
}

main().catch((e) => { console.error('acquisition failed:', e.message); process.exit(1); });
