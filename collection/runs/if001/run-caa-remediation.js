'use strict';

// CR-CAA-001 — CAA Conditional Operational Remediation runner
//
// Governance: SLG-064 `[C]` Conditional Operational Remediation, triggered by
// SLG-067 (CAA Collector Validation) — the Stage-3 trust gate failed on
// acceptance criterion 3 ("no systematic presence/absence bias"), disqualifying
// NOB-CAA-001 from calibration.
//
// What this does, and only this:
//   • Re-observes the SAME authoritative national population (the canonical
//     Organisation Dataset, VERIFIED domains) that produced NOB-CAA-001.
//   • Uses the EXACT production collect+insert path — `runCaa()` imported from
//     run-all.js — so there is no code duplication and no observation drift.
//   • CAA is isolated by construction: this process runs CAA and nothing else,
//     over its own dedicated c-ares channel (run-all.js `makeCaaResolver`).
//
// What this does NOT do:
//   • It does not modify the CAA collector (unchanged; suitable per SLG-065/067).
//   • It does not touch, update or delete a single existing row. `signal_facts_caa`
//     is append-only, so NOB-CAA-001 is preserved unchanged by construction.
//   • It does not score, rate, weight or benchmark anything.
//   • It does not write the Observatory collection report (that would overwrite
//     the multi-signal report of a prior run — historical evidence).
//
// Baseline identity: `signal_facts_caa` is a v0 schema with no `run_id` column
// (SLG-066 G1). The run UUID below is logged for RUN_REGISTER.md; the resulting
// baseline NOB-CAA-001R is identified by its `collected_at` window, printed at
// the end of the run and quoted verbatim in SLG-068.
//
// Operational retry pass (`--retry-unknown`): a national single-channel run of this
// size can exhaust the resolver path and record transient DNS_FAILURE on domains
// that are perfectly reachable — the per-source-IP effect first recorded in
// SLG-050 for DKIM. Re-collecting only the residual unknowns, on a fresh channel
// (optionally public resolvers), is an OPERATIONAL measure: it changes nothing
// about what is observed, only how many attempts are made. It appends new rows;
// the baseline snapshot takes the latest observation per domain within the window,
// exactly as NOB-DKIM-001R did.
//
// Usage:
//   node backend/collection/runs/if001/run-caa-remediation.js --dry-run
//   node backend/collection/runs/if001/run-caa-remediation.js --confirm
//   node backend/collection/runs/if001/run-caa-remediation.js --retry-unknown <windowStartISO>
//
// Environment (all optional): CONCURRENCY, CAA_DNS_TIMEOUT_MS, CAA_DNS_TRIES,
// CAA_DNS_SERVERS.

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const { randomUUID } = require('node:crypto');
const { loadOrganisations } = require('../../../acquisition/providers/organisation-provider');
const { getClient, runCaa } = require('./run-all');

// Latest observation per domain at/after `windowStart`, restricted to non-observations.
async function residualUnknowns(supabase, windowStart) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('signal_facts_caa')
      .select('domain,collected_at,dns_caa_present,caa_collection_error')
      .gte('collected_at', windowStart)
      .order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const latest = new Map();
  for (const r of rows) {
    const cur = latest.get(r.domain);
    if (!cur || r.collected_at > cur.collected_at) latest.set(r.domain, r);
  }
  return [...latest.values()].filter(r => r.dns_caa_present === null).map(r => r.domain);
}

const HR = '─'.repeat(76);

async function main() {
  const dryRun  = process.argv.includes('--dry-run');
  const confirm = process.argv.includes('--confirm');
  const retryIx = process.argv.indexOf('--retry-unknown');
  const retryFrom = retryIx >= 0 ? process.argv[retryIx + 1] : null;

  if (retryFrom) {
    console.log(`\n${HR}`);
    console.log(' CR-CAA-001 — operational retry pass over residual non-observations');
    console.log(`${HR}\n`);
    const supabase = getClient();
    const domains  = await residualUnknowns(supabase, retryFrom);
    console.log(`  Window start   : ${retryFrom}`);
    console.log(`  Residual unknown domains: ${domains.length}`);
    console.log(`  CAA transport  : fresh c-ares channel · timeout ${process.env.CAA_DNS_TIMEOUT_MS ?? 8000}ms` +
                ` · tries ${process.env.CAA_DNS_TRIES ?? 3} · servers ${process.env.CAA_DNS_SERVERS || '(system)'}`);
    console.log(`  Concurrency    : ${process.env.CONCURRENCY ?? 8}\n`);
    if (!domains.length) { console.log('  Nothing to retry.\n'); return; }
    if (!confirm) { console.log('  Pass --confirm to execute the retry.\n'); return; }

    const runId = randomUUID();
    const start = Date.now();
    console.log(`  Retry run UUID (not persisted — v0 schema): ${runId}\n`);
    const stats = await runCaa(domains.map(d => ({ domain: d })), supabase, runId, start);
    console.log(`\n  Retried ${stats.attempted}, completed ${stats.completed}, errors ${stats.collectorErrors + stats.dbErrors}, ${stats.elapsedSec}s`);
    const after = await residualUnknowns(supabase, retryFrom);
    console.log(`  Residual unknowns now: ${after.length}  (recovered ${domains.length - after.length})`);
    console.log(`  Window now extends to ${new Date(Date.now() + 1000).toISOString()}`);
    console.log(`\n${HR}\n`);
    return;
  }

  if (!dryRun && !confirm) {
    console.error('Refusing to run. Pass --dry-run to inspect the population, or --confirm to collect.');
    process.exit(1);
  }

  console.log(`\n${HR}`);
  console.log(' CR-CAA-001 — CAA Conditional Operational Remediation');
  console.log(`${HR}\n`);

  const cohort = loadOrganisations();
  const firms  = cohort.organisations;

  console.log(`  Population source : ${cohort.cohort_id} — ${cohort.cohort_name}`);
  console.log(`  Selection id      : ${cohort.selection_id}`);
  console.log(`  Organisations     : ${firms.length}`);
  console.log(`  Distinct domains  : ${new Set(firms.map(f => f.domain)).size}`);
  console.log(`  Concurrency       : ${process.env.CONCURRENCY ?? 8}`);
  console.log(`  CAA transport     : dedicated c-ares channel · timeout ${process.env.CAA_DNS_TIMEOUT_MS ?? 8000}ms` +
              ` · tries ${process.env.CAA_DNS_TRIES ?? 3} · servers ${process.env.CAA_DNS_SERVERS || '(system)'}`);
  console.log(`  Isolation         : CAA only — no other signal runs in this process\n`);

  if (dryRun) {
    console.log('  DRY RUN — no observation collected, no row written.\n');
    return;
  }

  const supabase = getClient();
  const runId    = randomUUID();
  const start    = Date.now();

  console.log(`  Run UUID (for RUN_REGISTER.md; NOT persisted — v0 schema): ${runId}`);
  console.log(`  Window opens: ${new Date(start).toISOString()}\n`);

  const stats = await runCaa(firms, supabase, runId, start);

  const end = Date.now();
  console.log(`\n${HR}`);
  console.log(' CR-CAA-001 — COLLECTION COMPLETE');
  console.log(`${HR}\n`);
  console.log(`  Attempted        : ${stats.attempted}`);
  console.log(`  Completed        : ${stats.completed}`);
  console.log(`  Collector errors : ${stats.collectorErrors}`);
  console.log(`  DB errors        : ${stats.dbErrors}`);
  console.log(`  Success rate     : ${stats.successRate}%`);
  console.log(`  Elapsed          : ${stats.elapsedSec}s`);
  console.log(`\n  NOB-CAA-001R collected_at window:`);
  console.log(`    from (inclusive) ${new Date(start).toISOString()}`);
  console.log(`    to   (exclusive) ${new Date(end + 1000).toISOString()}`);
  console.log(`\n  NOB-CAA-001 is untouched (append-only table).`);
  console.log(`\n${HR}\n`);
}

if (require.main === module) {
  main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
}
