'use strict';

/*
 * National Observatory Baseline 001 — gentle completion runner.
 *
 * Founder directive (2026-07-07): complete the baseline faithfully, not fast.
 *   • resume only INCOMPLETE observations; never rescan completed ones
 *   • low concurrency (~5 workers), small resumable batches
 *   • maintain provenance (reuses the exact production collectors)
 *   • a domain missing after MAX_ATTEMPTS re-collections is a PERMANENT failure
 *   • record operational metrics (throughput, batch duration, retries,
 *     transient failures, DB response times)
 *
 * Fully resumable + idempotent: gap is recomputed from the DB per signal; state
 * (permanent failures, attempt counts) is persisted so any interruption resumes
 * cleanly. Heavy full-table scans are done ONCE per signal per run; per-batch
 * recovery is checked with a bounded `.in(domain,…)` query to stay gentle.
 *
 * Usage: node backend/observatory/baseline/complete.js
 * Env: CONCURRENCY (default 5), BATCH (default 400), MAX_ATTEMPTS (default 2),
 *      PAUSE_MS (default 500), SIGNAL (optional — restrict to one signal id)
 */

const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

// Set gentle concurrency BEFORE requiring the pipeline (it reads CONCURRENCY at load).
process.env.CONCURRENCY = process.env.CONCURRENCY || '5';
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { loadOrganisations } = require('../../acquisition/providers/organisation-provider');
const { normaliseDomain } = require('../../authority/lib/normalise');
const pipeline = require('../../collection/runs/if001/run-all');

const DIR = __dirname;
const DATASET = path.join(DIR, 'dataset');
const START_FILE = path.join(DIR, 'BASELINE_START.txt');
const STATE_FILE = path.join(DATASET, 'completion-state.json');
const METRICS_FILE = path.join(DATASET, 'completion-metrics.ndjson');

const BATCH = Number(process.env.BATCH || 400);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 2);
const PAUSE_MS = Number(process.env.PAUSE_MS || 500);
// Optional wall-clock budget: exit gracefully (state saved) after this many
// seconds so the runner can be driven as reliable short foreground chunks in an
// environment that reaps long-lived background processes. 0 = run to completion.
const MAX_RUN_SECONDS = Number(process.env.MAX_RUN_SECONDS || 0);
const RUN_START = Date.now();
const outOfTime = () => MAX_RUN_SECONDS > 0 && (Date.now() - RUN_START) / 1000 >= MAX_RUN_SECONDS;

// Order: fast DNS signals first, already-complete ones fall through instantly,
// slow HTTP signals (headers, security.txt) last.
const SIGNALS = [
  { id: 'SOT-SPF-001', table: 'signal_facts_spf', run: pipeline.runSpf },
  { id: 'SOT-DKIM-001', table: 'signal_facts_dkim', run: pipeline.runDkim },
  { id: 'SOT-MTASTS-001', table: 'signal_facts_mtasts', run: pipeline.runMtaSts },
  { id: 'SOT-DMARC-001', table: 'signal_facts_dmarc', run: pipeline.runDmarc },
  { id: 'SOT-DNSSEC-001', table: 'signal_facts_dnssec', run: pipeline.runDnssec },
  { id: 'SOT-CAA-001', table: 'signal_facts_caa', run: pipeline.runCaa },
  { id: 'SOT-TLSRPT-001', table: 'signal_facts_tlsrpt', run: pipeline.runTlsRpt },
  { id: 'SOT-SECURITYHEADERS-001', table: 'signal_securityheaders_v1', run: pipeline.runSecurityHeaders },
  { id: 'SOT-SECURITYTXT-001', table: 'signal_securitytxt_v1', run: pipeline.runSecurityTxt },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { perSignal: {} }; }
}
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); }
function recordMetric(m) { fs.appendFileSync(METRICS_FILE, JSON.stringify(m) + '\n', 'utf8'); }

// One full scan of a signal's in-window observed domains (heavy — once per signal per run).
async function fullObserved(sb, table, since) {
  const set = new Set();
  const t0 = Date.now();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('domain').gte('collected_at', since).order('domain').range(from, from + 999);
    if (error) throw new Error(`${table} scan: ${error.message}`);
    if (!data || !data.length) break;
    for (const r of data) { const d = normaliseDomain(r.domain); if (d) set.add(d); }
    if (data.length < 1000) break;
  }
  return { set, ms: Date.now() - t0 };
}

// Bounded recovery check: which of these (<=BATCH) domains now have an in-window row.
async function observedIn(sb, table, since, domains) {
  const found = new Set();
  const t0 = Date.now();
  for (let i = 0; i < domains.length; i += 300) {
    const chunk = domains.slice(i, i + 300);
    const { data, error } = await sb.from(table).select('domain').gte('collected_at', since).in('domain', chunk);
    if (error) throw new Error(`${table} recovery: ${error.message}`);
    for (const r of data) { const d = normaliseDomain(r.domain); if (d) found.add(d); }
  }
  return { found, ms: Date.now() - t0 };
}

async function completeSignal(sb, sig, byDomain, since, state) {
  const st = state.perSignal[sig.id] || (state.perSignal[sig.id] = { permanent: [], attempts: {}, done: false });
  const permanent = new Set(st.permanent);
  const attempts = st.attempts;

  const { set: observed, ms: scanMs } = await fullObserved(sb, sig.table, since);
  let missing = [...byDomain.keys()].filter((d) => !observed.has(d) && !permanent.has(d));
  console.log(`[complete] ${sig.id}: observed ${observed.size}/${byDomain.size} · missing ${missing.length} · permanent ${permanent.size} · scan ${scanMs}ms`);

  let batchNo = 0;
  while (missing.length > 0) {
    batchNo++;
    const batchDomains = missing.slice(0, BATCH);
    const batchFirms = batchDomains.map((d) => byDomain.get(d));
    for (const d of batchDomains) attempts[d] = (attempts[d] || 0) + 1;

    const t1 = Date.now();
    const stats = await sig.run(batchFirms, sb, randomUUID(), t1);
    const batchDurSec = (Date.now() - t1) / 1000;

    const { found: recoveredSet, ms: recMs } = await observedIn(sb, sig.table, since, batchDomains);
    let recovered = 0, transient = 0, permanentNew = 0;
    for (const d of batchDomains) {
      if (recoveredSet.has(d)) { observed.add(d); recovered++; }
      else if (attempts[d] >= MAX_ATTEMPTS) { permanent.add(d); permanentNew++; }
      else { transient++; }
    }

    recordMetric({
      ts: new Date().toISOString(), signal: sig.id, batch: batchNo, batchSize: batchDomains.length,
      recovered, transientRemaining: transient, permanentNew,
      collectorErrors: stats.collectorErrors, dbErrors: stats.dbErrors,
      batchDurSec: Number(batchDurSec.toFixed(1)),
      throughputDomainsPerSec: Number((batchDomains.length / Math.max(batchDurSec, 0.001)).toFixed(2)),
      dbRecoveryQueryMs: recMs,
    });

    st.permanent = [...permanent];
    st.attempts = attempts;
    saveState(state);

    missing = [...byDomain.keys()].filter((d) => !observed.has(d) && !permanent.has(d));
    console.log(`  ${sig.id} batch ${batchNo}: +${recovered} recovered, ${transient} transient, ${permanentNew} permanent · ${batchDurSec.toFixed(1)}s · remaining ${missing.length}`);
    if (outOfTime()) { console.log(`  [time budget reached — pausing ${sig.id}, ${missing.length} remaining; resume by re-running]`); return false; }
    if (PAUSE_MS) await sleep(PAUSE_MS);
  }

  st.done = true;
  st.observed = observed.size;
  saveState(state);
  console.log(`[complete] ${sig.id}: DONE — observed ${observed.size}, permanent failures ${permanent.size}`);
  return true;
}

async function main() {
  const sb = pipeline.getClient();
  const since = fs.readFileSync(START_FILE, 'utf8').trim();
  const firms = loadOrganisations().organisations; // canonical VERIFIED population only
  const byDomain = new Map(firms.map((f) => [normaliseDomain(f.domain), f]));
  const only = process.env.SIGNAL || null;
  const state = loadState();
  state.since = since;

  console.log(`Gentle completion — concurrency ${process.env.CONCURRENCY}, batch ${BATCH}, maxAttempts ${MAX_ATTEMPTS}, pause ${PAUSE_MS}ms`);
  console.log(`Population: ${byDomain.size} VERIFIED domains · window since ${since}\n`);

  for (const sig of SIGNALS) {
    if (only && sig.id !== only) continue;
    if (state.perSignal[sig.id] && state.perSignal[sig.id].done) { console.log(`[complete] ${sig.id}: already done — skipping`); continue; }
    const finished = await completeSignal(sb, sig, byDomain, since, state);
    if (finished === false) { console.log('TIME_BUDGET_EXIT — re-run to resume'); process.exit(3); }
  }

  // Summary of permanent failures across signals.
  const summary = {};
  for (const [sigId, st] of Object.entries(state.perSignal)) summary[sigId] = { done: !!st.done, observed: st.observed ?? null, permanent: (st.permanent || []).length };
  fs.writeFileSync(path.join(DATASET, 'completion-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('\nCompletion summary:', JSON.stringify(summary, null, 2));
  console.log('ALL SIGNALS PROCESSED (completed or permanently failed).');
}

if (require.main === module) {
  main().catch((e) => { console.error('Completion failed:', e.stack || e.message); process.exit(1); });
}

module.exports = { main };
