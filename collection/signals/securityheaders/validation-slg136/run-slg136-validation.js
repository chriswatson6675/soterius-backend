'use strict';

// SLG-136 ENGINEERING VALIDATION — Security Headers v2 collector
// ================================================================
// PURPOSE: engineering validation ONLY. This is NOT a national baseline, does
// NOT regenerate the Quality Model, does NOT compute distributions or weights,
// and does NOT create NOB-002. It re-runs the harmonised v2 collector against
// EXACTLY the organisations that FAILED in the previous Security Headers
// national collection (NOB-SECURITYHEADERS-001, run 34fa4a90…) and reports
// whether the SLG-136 source-authentication suppression fix behaves as designed.
//
// It writes NOTHING to any canonical table or baseline artefact. Raw results go
// to ./results.ndjson and ./report.json in this validation directory only.
//
// Usage:  node collection/signals/securityheaders/validation-slg136/run-slg136-validation.js
// Env:    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ; CONCURRENCY (default 25)

const fs   = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '../../../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { collectSecurityHeaders, COLLECTOR_VERSION, SIGNAL_VERSION } =
  require('../securityheaders-collector');

const BASELINE_RUN = '34fa4a90-dd4e-4497-8a01-0d38f9b00134'; // NOB-SECURITYHEADERS-001 (v1)
const CONCURRENCY  = Number(process.env.CONCURRENCY ?? 25);
const OUT_DIR      = __dirname;
const RESULTS_NDJSON = path.join(OUT_DIR, 'results.ndjson');
const REPORT_JSON    = path.join(OUT_DIR, 'report.json');

// NOT_OBSERVED is a reporting umbrella for non-response states that are neither
// TLS_ERROR nor CONNECTION_ERROR (i.e. TIMEOUT + REDIRECT_UNRESOLVED).
function bucket(endpointState) {
  if (endpointState === 'RESPONSE_OBSERVED') return 'RESPONSE_OBSERVED';
  if (endpointState === 'TLS_ERROR')         return 'TLS_ERROR';
  if (endpointState === 'CONNECTION_ERROR')  return 'CONNECTION_ERROR';
  return 'NOT_OBSERVED'; // TIMEOUT | REDIRECT_UNRESOLVED
}

async function loadFailedCohort(s) {
  const cohort = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await s
      .from('signal_securityheaders_v1')
      .select('domain,endpoint_state,http_probe_state')
      .eq('run_id', BASELINE_RUN)
      .neq('endpoint_state', 'RESPONSE_OBSERVED')
      .order('domain', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`cohort read failed: ${error.message}`);
    cohort.push(...data);
    if (data.length < 1000) break;
  }
  return cohort;
}

async function pool(items, worker, conc) {
  const results = new Array(items.length);
  let idx = 0, done = 0;
  async function run() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      done++;
      if (done % 200 === 0 || done === items.length) {
        process.stdout.write(`  [${String(Math.round((done/items.length)*100)).padStart(3)}%] ${done}/${items.length}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, run));
  return results;
}

async function main() {
  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log('SLG-136 ENGINEERING VALIDATION — Security Headers v2');
  console.log(`  collector: ${SIGNAL_VERSION} (v${COLLECTOR_VERSION})`);
  console.log(`  baseline : ${BASELINE_RUN} (NOB-SECURITYHEADERS-001, v1)`);
  console.log('  reading previously-failed cohort…');

  const cohort = await loadFailedCohort(s);
  const prevByDomain = new Map(cohort.map(r => [r.domain, r.endpoint_state]));
  console.log(`  cohort: ${cohort.length} previously-failed organisations`);
  const prevCounts = { TLS_ERROR: 0, CONNECTION_ERROR: 0, NOT_OBSERVED: 0 };
  for (const r of cohort) prevCounts[bucket(r.endpoint_state)]++;
  console.log(`  prev buckets: TLS_ERROR=${prevCounts.TLS_ERROR} CONNECTION_ERROR=${prevCounts.CONNECTION_ERROR} NOT_OBSERVED=${prevCounts.NOT_OBSERVED}\n`);

  const outStream = fs.createWriteStream(RESULTS_NDJSON);

  let c1Violations = 0;
  const rows = await pool(cohort, async (r) => {
    const domain = r.domain;
    let rec, collectorError = null;
    try {
      rec = await collectSecurityHeaders(domain); // v2, permissive capture
    } catch (err) {
      // C-1 requires the collector to ALWAYS return an observation — a throw is
      // itself a defect to surface.
      collectorError = err.message;
      c1Violations++;
      rec = null;
    }
    const presentHeaders = rec
      ? Object.entries(rec.header_inventory).filter(([, v]) => v.present).map(([k]) => k)
      : [];
    const out = {
      domain,
      prev_endpoint_state: r.endpoint_state,
      prev_bucket:         bucket(r.endpoint_state),
      new_endpoint_state:  rec ? rec.endpoint_state : 'COLLECTOR_THREW',
      new_bucket:          rec ? bucket(rec.endpoint_state) : 'COLLECTOR_THREW',
      http_probe_state:    rec ? rec.http_probe_state : null,
      tls_verification_result: rec ? rec.tls_verification_result : null,
      tls_error_code:          rec ? rec.tls_error_code : null,
      http_status:         rec ? rec.https_fetch.http_status : null,
      redirect_hops:       rec ? rec.https_fetch.redirect_chain.length : null,
      present_header_count: presentHeaders.length,
      hsts_present:        rec ? rec.header_inventory.strict_transport_security.present : null,
      present_headers:     presentHeaders,
      collector_error:     collectorError,
    };
    outStream.write(JSON.stringify(out) + '\n');
    return out;
  }, CONCURRENCY);

  await new Promise(res => outStream.end(res));

  // ── Aggregate ────────────────────────────────────────────────────────────
  const tested = rows.length;
  const recovered = rows.filter(r => r.new_endpoint_state === 'RESPONSE_OBSERVED');
  const stillTls  = rows.filter(r => r.new_endpoint_state === 'TLS_ERROR');
  const stillConn = rows.filter(r => r.new_endpoint_state === 'CONNECTION_ERROR');
  const stillNobs = rows.filter(r => r.new_bucket === 'NOT_OBSERVED');

  // Transition matrix prev_bucket -> new_bucket
  const buckets = ['TLS_ERROR', 'CONNECTION_ERROR', 'NOT_OBSERVED'];
  const newBuckets = ['RESPONSE_OBSERVED', 'TLS_ERROR', 'CONNECTION_ERROR', 'NOT_OBSERVED', 'COLLECTOR_THREW'];
  const matrix = {};
  for (const b of buckets) {
    matrix[b] = {};
    for (const nb of newBuckets) matrix[b][nb] = 0;
  }
  for (const r of rows) matrix[r.prev_bucket][r.new_bucket]++;

  // Recovered-by-verdict (all recovered)
  const verdictAll = {};
  for (const r of recovered) {
    const v = r.tls_verification_result ?? 'null';
    verdictAll[v] = (verdictAll[v] ?? 0) + 1;
  }
  // The engineering fix specifically: prev TLS_ERROR now RESPONSE_OBSERVED.
  const tlsFixRecovered = recovered.filter(r => r.prev_bucket === 'TLS_ERROR');
  const verdictTlsFix = {};
  for (const r of tlsFixRecovered) {
    const v = r.tls_verification_result ?? 'null';
    verdictTlsFix[v] = (verdictTlsFix[v] ?? 0) + 1;
  }

  const report = {
    generated_at_note: 'engineering validation only — not a baseline',
    collector: SIGNAL_VERSION,
    baseline_run: BASELINE_RUN,
    concurrency: CONCURRENCY,
    tested,
    prev_buckets: prevCounts,
    recovered_total: recovered.length,
    recovered_via_source_auth_fix: tlsFixRecovered.length,   // prev TLS_ERROR -> RESPONSE_OBSERVED
    recovered_incidental: recovered.length - tlsFixRecovered.length, // prev CONN/NOT_OBS -> observed (transient)
    still_tls_error: stillTls.length,
    still_connection_error: stillConn.length,
    still_not_observed: stillNobs.length,
    collector_threw_c1_violations: c1Violations,
    transition_matrix: matrix,
    recovered_by_verdict_all: verdictAll,
    recovered_by_verdict_source_auth_fix: verdictTlsFix,
    unauthenticated_captures: recovered.filter(r => r.tls_verification_result && r.tls_verification_result !== 'CHAIN_VERIFIED').length,
    chain_verified_captures:  recovered.filter(r => r.tls_verification_result === 'CHAIN_VERIFIED').length,
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));

  console.log('\n================ VALIDATION REPORT ================');
  console.log(JSON.stringify(report, null, 2));

  // Representative examples: prioritise TLS_ERROR -> RESPONSE_OBSERVED with
  // distinct verdicts, plus one still-failing of each kind for honesty.
  const seenVerdict = new Set();
  const examples = [];
  for (const r of tlsFixRecovered) {
    const v = r.tls_verification_result;
    if (!seenVerdict.has(v)) { seenVerdict.add(v); examples.push(r); }
    if (examples.length >= 6) break;
  }
  const stillTlsEx = stillTls[0];
  const stillConnEx = stillConn[0];
  if (stillTlsEx) examples.push(stillTlsEx);
  if (stillConnEx) examples.push(stillConnEx);
  console.log('\n---------------- REPRESENTATIVE EXAMPLES ----------------');
  for (const e of examples) {
    console.log(JSON.stringify({
      domain: e.domain,
      previous: e.prev_endpoint_state,
      new: e.new_endpoint_state,
      verdict: e.tls_verification_result,
      code: e.tls_error_code,
      http_status: e.http_status,
      headers_now_present: e.present_headers,
    }));
  }
  console.log('\nRESULTS_NDJSON=' + RESULTS_NDJSON);
  console.log('REPORT_JSON=' + REPORT_JSON);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
