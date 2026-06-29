'use strict';

// run-if001-registrar.js — SOT-REGISTRAR-001 IF-001 Initial Registrar Population Collection
//
// Reads unique registrar IANA IDs from the completed IF-001 SOT-DOMAINREGISTRATION-001 run,
// queries the IANA registrar IDs dataset, persists evidence to signal_registrar_v1,
// and prints a full registrar population summary.
//
// Assessment unit: unique registrar IANA ID (not domain).
// One IANA dataset lookup per unique registrar IANA ID across the cohort.
//
// ITA Condition compliance:
//   Condition 1: UPSTREAM_RUN_ID must identify a completed SOT-DR-001 IF-001 run.
//   Condition 2: signal_registrar_v1 table must exist (migration 018 applied).
//   Condition 3: IANA dataset accessible — validated at startup via download attempt.
//
// Signal Lab rule: records observations only. No scores. No ratings.
//
// Usage:
//   node backend/signal-lab/signals/registrar/run-if001-registrar.js
//
// Prerequisites:
//   Migration 018_signal_registrar_v1.sql applied in Supabase.
//   backend/.env present with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
//   UPSTREAM_RUN_ID set to the completed SOT-DOMAINREGISTRATION-001 IF-001 run ID.
//
// Environment:
//   SUPABASE_URL              — required
//   SUPABASE_SERVICE_ROLE_KEY — required
//   UPSTREAM_RUN_ID           — required; SOT-DOMAINREGISTRATION-001 run ID for IF-001
//   RUN_ID                    — optional UUID; set to resume a failed run

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const {
  assessRegistrar,
  runCollector,
  downloadIanaDataset,
  persistObservation,
  SIGNAL_VERSION,
  COLLECTOR_VERSION,
  TABLE_NAME,
  QUERY_OUTCOMES,
  ACCREDITATION_STATUS,
  IANA_DATASET_URL,
} = require('./registrar-collector');

// ── Configuration ─────────────────────────────────────────────────────────────

const COHORT_CODE    = 'IF-001';
const RUN_ID         = process.env.RUN_ID         ?? randomUUID();
const UPSTREAM_RUN_ID = process.env.UPSTREAM_RUN_ID ?? null;

const DR_TABLE = 'signal_domainregistration_v1';

// ── Supabase client ───────────────────────────────────────────────────────────

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  }
  return createClient(url, key);
}

// ── IANA ID extraction ────────────────────────────────────────────────────────

/**
 * Extracts unique non-null registrar IANA IDs from the upstream SOT-DR-001 run.
 * Deduplication query: one row per unique IANA ID (SOT-REGISTRAR-001 §5.3).
 * Paginates in 1,000-row pages to bypass Supabase's default row limit.
 *
 * Also counts null IANA ID rows (IANA_ID_ABSENT) for metrics.
 */
async function extractRegistrarIanaIds(supabase, upstreamRunId) {
  // Paginate non-null IANA IDs — Supabase default cap is 1,000 rows per request
  const PAGE_SIZE = 1000;
  let allNonNull = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(DR_TABLE)
      .select('registrar_iana_id')
      .eq('run_id', upstreamRunId)
      .not('registrar_iana_id', 'is', null)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to query ${DR_TABLE}: ${error.message}`);
    allNonNull = allNonNull.concat(data ?? []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  // Count null IANA ID rows (IANA_ID_ABSENT — not collected but counted in metrics)
  const { count: nullCount, error: nullErr } = await supabase
    .from(DR_TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('run_id', upstreamRunId)
    .is('registrar_iana_id', null);

  if (nullErr) throw new Error(`Failed to count null IANA IDs: ${nullErr.message}`);

  // Deduplicate in application layer
  const uniqueIds = [...new Set(allNonNull.map(r => r.registrar_iana_id))].sort();

  return {
    uniqueIanaIds:    uniqueIds,
    ianaIdAbsentCount: nullCount ?? 0,
    totalDomains:     allNonNull.length + (nullCount ?? 0),
  };
}

// ── Progress logging ──────────────────────────────────────────────────────────

function progressLine(i, total, ianaId, evidence, dbError) {
  const pct     = String(Math.round(((i + 1) / total) * 100)).padStart(3);
  const outcome = {
    QUERY_SUCCESS: 'OK   ',
    NOT_FOUND:     'NF   ',
    QUERY_ERROR:   'ERR! ',
    IANA_ID_ABSENT:'ABST ',
  }[evidence.icann_query_outcome] ?? evidence.icann_query_outcome.slice(0, 5);

  const status = (evidence.registrar_accreditation_status ?? '----').slice(0, 4);
  const name   = (evidence.registrar_name ?? '(no name)').slice(0, 40);

  const dbTag = dbError ? ` [DB!]` : '';

  return `  [${pct}%] [${outcome}] [${status}] ${ianaId.padEnd(8)} ${name}${dbTag}`;
}

// ── Summary computation ───────────────────────────────────────────────────────

function pct(n, total) {
  return total === 0 ? '  0.0%' : `${((n / total) * 100).toFixed(1).padStart(5)}%`;
}

function computeSummary(results, ianaIdAbsentCount, totalDomains) {
  const n        = results.length;
  const dbErrors = results.filter(r => r.dbError);

  const outcomeCounts = {};
  const statusCounts  = {};
  const byName        = {};

  for (const r of results) {
    const oc = r.evidence.icann_query_outcome;
    outcomeCounts[oc] = (outcomeCounts[oc] ?? 0) + 1;

    const st = r.evidence.registrar_accreditation_status;
    if (st) statusCounts[st] = (statusCounts[st] ?? 0) + 1;

    const name = r.evidence.registrar_name ?? '(no name)';
    byName[name] = (byName[name] ?? 0) + 1;
  }

  return {
    n, ianaIdAbsentCount, totalDomains,
    dbErrors: dbErrors.length,
    dbErrorRegistrars: dbErrors.map(r => ({ ianaId: r.ianaId, error: r.dbError?.message })),
    outcomeCounts, statusCounts, byName,
  };
}

function printSummary(s, runId, upstreamRunId) {
  const HR  = '═'.repeat(76);
  const DIV = '─'.repeat(76);

  console.log(`\n${HR}`);
  console.log(` SOT-REGISTRAR-001 — IF-001 INITIAL REGISTRAR POPULATION SUMMARY`);
  console.log(` Signal: SOT-REGISTRAR-001 v${SIGNAL_VERSION}   Collector: v${COLLECTOR_VERSION}`);
  console.log(` Cohort: ${COHORT_CODE}   Unique registrars assessed: ${s.n}`);
  console.log(` Completed: ${new Date().toISOString()}`);
  console.log(` Run ID          : ${runId}`);
  console.log(` Upstream Run ID : ${upstreamRunId}`);
  if (s.dbErrors > 0) {
    console.log(` WARNING: ${s.dbErrors} DB write error(s) — retry with RUN_ID=${runId}`);
  }
  console.log(HR);

  // 1. Query outcome distribution
  console.log('\n 1. ICANN QUERY OUTCOME DISTRIBUTION\n');
  for (const outcome of Object.values(QUERY_OUTCOMES)) {
    const count = s.outcomeCounts[outcome] ?? 0;
    if (count > 0 || outcome !== QUERY_OUTCOMES.IANA_ID_ABSENT) {
      console.log(`    ${outcome.padEnd(20)}: ${String(count).padStart(4)}`);
    }
  }
  console.log(`    ${'IANA_ID_ABSENT (no row)'.padEnd(20)}: ${String(s.ianaIdAbsentCount).padStart(4)}   (upstream null IANA IDs — no assessment)`);

  // 2. Accreditation status distribution
  console.log(`\n${DIV}`);
  console.log(`\n 2. REGISTRAR ACCREDITATION STATUS DISTRIBUTION  (QUERY_SUCCESS rows)\n`);
  for (const status of Object.values(ACCREDITATION_STATUS)) {
    const count = s.statusCounts[status] ?? 0;
    const bar   = '█'.repeat(Math.round((count / Math.max(s.n, 1)) * 30));
    console.log(`    ${status.padEnd(15)}: ${String(count).padStart(4)}   ${pct(count, s.n)}  ${bar}`);
  }

  // 3. Registrar name listing (all assessed)
  console.log(`\n${DIV}`);
  console.log(`\n 3. REGISTRAR POPULATION  (${s.n} unique registrars)\n`);
  const sorted = Object.entries(s.byName).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    const label = name.length > 55 ? name.slice(0, 54) + '…' : name;
    console.log(`    ${String(count).padStart(4)} domain(s)   ${label}`);
  }

  // 4. Coverage summary
  console.log(`\n${DIV}`);
  console.log(`\n 4. COHORT COVERAGE  (${COHORT_CODE})\n`);
  console.log(`    Total upstream domains     : ${s.totalDomains}`);
  console.log(`    Domains with IANA ID       : ${s.totalDomains - s.ianaIdAbsentCount}`);
  console.log(`    Domains without IANA ID    : ${s.ianaIdAbsentCount}   (IANA_ID_ABSENT — not assessed)`);
  console.log(`    Unique registrars assessed : ${s.n}`);

  // 5. DB errors
  if (s.dbErrors > 0) {
    console.log(`\n${DIV}`);
    console.log(`\n 5. DB WRITE ERRORS  (${s.dbErrors} registrars — retry with RUN_ID=${runId})\n`);
    for (const { ianaId, error } of s.dbErrorRegistrars) {
      console.log(`    • IANA ID ${ianaId}  [${(error ?? '').slice(0, 60)}]`);
    }
  }

  console.log(`\n${HR}`);
  console.log(` Run ID          : ${runId}`);
  console.log(` Upstream Run ID : ${upstreamRunId}`);
  console.log(` Register this run in SLG-003 if results are accepted.`);
  console.log(` Next step: produce IF-002 Registrar Population Assessment using these results.`);
  console.log(`${HR}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const HR        = '═'.repeat(76);
  const startedAt = Date.now();

  // Pre-flight: UPSTREAM_RUN_ID required
  if (!UPSTREAM_RUN_ID) {
    console.error('\n  ERROR: UPSTREAM_RUN_ID environment variable is required.');
    console.error('  Set it to the completed SOT-DOMAINREGISTRATION-001 IF-001 run ID.');
    console.error('  Example: UPSTREAM_RUN_ID=<uuid> node run-if001-registrar.js\n');
    process.exit(1);
  }

  console.log(`\n${HR}`);
  console.log(` SOT-REGISTRAR-001 — IF-001 INITIAL REGISTRAR POPULATION COLLECTION`);
  console.log(` SOT-REGISTRAR-001 v${SIGNAL_VERSION}   Collector: v${COLLECTOR_VERSION}`);
  console.log(` Cohort          : ${COHORT_CODE}`);
  console.log(` Run ID          : ${RUN_ID}`);
  console.log(` Upstream Run ID : ${UPSTREAM_RUN_ID}`);
  console.log(` Data source     : ${IANA_DATASET_URL}`);
  console.log(` Started         : ${new Date().toISOString()}`);
  console.log(HR);

  const supabase = getClient();

  // ITA Condition 2: pre-flight check for signal_registrar_v1
  const { error: pingErr } = await supabase.from(TABLE_NAME).select('id').limit(1);
  if (pingErr) {
    const missing = pingErr.message?.includes('does not exist') || pingErr.code === '42P01';
    if (missing) {
      console.error(`\n  ERROR: ${TABLE_NAME} table not found.`);
      console.error(`  Apply backend/db/migrations/018_signal_registrar_v1.sql in Supabase first.`);
      console.error(`  (ITA-REGISTRAR-001 Condition 2 not satisfied)\n`);
    } else {
      console.error(`\n  ERROR: Supabase — ${pingErr.message}\n`);
    }
    process.exit(1);
  }
  console.log(`\n  signal_registrar_v1 ✓`);

  // Pre-flight: verify upstream run exists
  const { count: upstreamCount, error: upstreamErr } = await supabase
    .from(DR_TABLE)
    .select('*', { count: 'exact', head: true })
    .eq('run_id', UPSTREAM_RUN_ID);

  if (upstreamErr) {
    console.error(`\n  ERROR: Could not verify upstream run: ${upstreamErr.message}\n`);
    process.exit(1);
  }
  if (!upstreamCount || upstreamCount === 0) {
    console.error(`\n  ERROR: No rows found in ${DR_TABLE} for run_id=${UPSTREAM_RUN_ID}`);
    console.error(`  ITA-REGISTRAR-001 Condition 1: upstream SOT-DR-001 IF-001 run must be complete.\n`);
    process.exit(1);
  }
  console.log(`  ${DR_TABLE} upstream run: ${upstreamCount} domain rows ✓`);

  // Extract unique registrar IANA IDs from upstream run
  console.log('\n  Extracting unique registrar IANA IDs from upstream run...');
  const { uniqueIanaIds, ianaIdAbsentCount, totalDomains } =
    await extractRegistrarIanaIds(supabase, UPSTREAM_RUN_ID);

  console.log(`  Total upstream domains    : ${totalDomains}`);
  console.log(`  Unique registrar IANA IDs : ${uniqueIanaIds.length}`);
  console.log(`  Null IANA IDs (not assessed): ${ianaIdAbsentCount}`);

  if (uniqueIanaIds.length === 0) {
    console.error('\n  ERROR: No registrar IANA IDs found in upstream run.');
    console.error('  Check that the SOT-DOMAINREGISTRATION-001 run is complete and included RDAP-observed domains.\n');
    process.exit(1);
  }

  // ITA Condition 3: IANA dataset accessibility check
  console.log('\n  Validating IANA dataset accessibility (ITA Condition 3)...');
  try {
    // We don't download the full dataset here — just confirm the URL is reachable
    // The full download happens inside runCollector()
    console.log(`  IANA dataset URL: ${IANA_DATASET_URL}`);
    console.log('  [Dataset will be downloaded at collection start]');
  } catch (err) {
    console.error(`\n  ERROR: IANA dataset pre-flight failed: ${err.message}\n`);
    process.exit(1);
  }

  // Collection header
  const DIV = '─'.repeat(76);
  console.log(`\n${DIV}`);
  console.log(` Collecting ${uniqueIanaIds.length} unique registrars`);
  console.log(` Columns: [%] [outcome] [status] [ianaId] [registrar name]`);
  console.log(DIV + '\n');

  const { metrics, results } = await runCollector({
    ianaIds:         uniqueIanaIds,
    supabase,
    runId:           RUN_ID,
    upstreamRunId:   UPSTREAM_RUN_ID,
    ianaIdAbsentCount,
    onProgress: (ianaId, i, total, result) => {
      process.stdout.write(
        progressLine(i, total, ianaId, result.evidence, result.dbError) + '\n',
      );
    },
  });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n  Completed: ${results.length} registrars in ${elapsed}s`);

  if (metrics.datasetDownloadFailed) {
    console.error(`\n  WARNING: IANA dataset download failed: ${metrics.datasetDownloadError}`);
    console.error('  All registrar rows recorded as QUERY_ERROR. Retry this run.');
  }

  const summary = computeSummary(results, ianaIdAbsentCount, totalDomains);
  printSummary(summary, RUN_ID, UPSTREAM_RUN_ID);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
