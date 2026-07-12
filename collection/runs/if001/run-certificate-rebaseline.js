'use strict';

// NOB-CERTIFICATE-001 v2 — Certificate-only national re-baseline
//
// Per Founder decision (2026-07-08, SLG-103 approval): the original
// NOB-CERTIFICATE-001 (SLG-102) was collected with a collector that had a
// confirmed C-6 defect (EC certificates misclassified as RSA — ~28.6% of the
// national population). The corrected collector (SLG-103) must be re-run
// against the same population to produce a v2 baseline before Stage 3
// (Collector Validation) proceeds.
//
// SOT-TLS-001 is unaffected by C-6/C-7 (both are certificate-only fields) and
// is already frozen (TLS-QM-v1.0, SLG-100) — re-writing signal_tls_v1 here
// would be a redundant, unjustified duplicate of a table that does not need
// re-collection. This script therefore reuses the EXACT production
// collect+extract path (createRunContext/collectTLSSession from
// tls-collection-layer.js, extractCertificateEvidence/promotedScalars from
// certificate-extractor.js — no duplicated logic) but persists ONLY to
// signal_certificate_v1, under a single fresh run_id, skipping the
// signal_tls_v1 insert entirely (unlike run-all.js's runTls(), which writes
// both tables from one shared handshake per ADR-COL-003).
//
// Usage: node backend/collection/runs/if001/run-certificate-rebaseline.js
// Env:   CONCURRENCY (default 8, matches run-all.js's Category D concurrency)

require('dotenv').config({ path: require('node:path').join(__dirname, '../../../.env') });

const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const { createRunContext, collectTLSSession } = require('../../signals/tls/tls-collection-layer');
const { extractCertificateEvidence, promotedScalars: certScalars } = require('../../signals/tls/certificate-extractor');
const { loadOrganisations } = require('../../../acquisition/providers/organisation-provider');

const COLLECTOR_VERSION = '1.0.0'; // unchanged constant name/value convention from run-all.js
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}

async function runWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Field-for-field identical to run-all.js's certInsert() — the persistence
// shape is a fixed contract (migration 015), not something this script
// should reinterpret.
function certInsert(domain, runId, certEvidence) {
  const scalars = certScalars(certEvidence);
  return {
    run_id:                  runId,
    domain,
    collected_at:            certEvidence.collected_at,
    signal_version:          '1.0.0',
    collector_version:       COLLECTOR_VERSION,
    endpoint_state:          scalars.endpoint_state,
    certificate_present:     scalars.certificate_present,
    tls_error_code:          scalars.tls_error_code,
    leaf_days_remaining:     scalars.leaf_days_remaining,
    leaf_issuer_cn:          scalars.leaf_issuer_cn,
    leaf_issuer_o:           scalars.leaf_issuer_o,
    leaf_subject_cn:         scalars.leaf_subject_cn,
    leaf_is_self_signed:     scalars.leaf_is_self_signed,
    leaf_is_wildcard:        scalars.leaf_is_wildcard,
    leaf_fingerprint_sha256: scalars.leaf_fingerprint_sha256,
    evidence:                certEvidence,
  };
}

async function main() {
  const HR = '='.repeat(72);

  let cohort;
  try {
    cohort = loadOrganisations();
  } catch (err) {
    if (err.code === 'ORG_DATASET_NOT_FOUND') {
      console.error('\n  ERROR: canonical Organisation Dataset not found.');
      console.error("  Run 'node backend/authority/build.js' to build the Repository Authority first.\n");
      process.exit(1);
    }
    throw err;
  }
  const firms = cohort.organisations;

  const supabase = getClient();
  const certRunId = randomUUID();
  const startedAt = Date.now();

  console.log(`\n${HR}`);
  console.log(' NOB-CERTIFICATE-001 v2 — Certificate-only national re-baseline');
  console.log(` Cohort: ${cohort.cohort_id}   n = ${cohort.n}   Concurrency: ${CONCURRENCY}`);
  console.log(` Selection ID: ${cohort.selection_id}`);
  console.log(` SOT-CERTIFICATE-001 run_id (NEW):  ${certRunId}`);
  console.log(' signal_tls_v1 is NOT written by this script (SOT-TLS-001 unaffected, already frozen).');
  console.log(' RECORD this run_id in SLG-003 (Run Register) once collection completes.');
  console.log(`${HR}\n`);

  const { error: pingErr } = await supabase.from('signal_certificate_v1').select('id').limit(1);
  if (pingErr) {
    console.error(`  ERROR: Cannot reach Supabase — ${pingErr.message}`);
    process.exit(1);
  }
  console.log('  Supabase: connected\n');

  const runContext = createRunContext();

  const results = await runWithConcurrency(firms, async (firm, i) => {
    let collectorError = null;
    let dbError = null;

    try {
      const session  = await collectTLSSession(firm.domain, runContext, { timeout: 30000 });
      const certEvid = extractCertificateEvidence(session);
      const { error } = await supabase.from('signal_certificate_v1').insert(certInsert(firm.domain, certRunId, certEvid));
      dbError = error?.message ?? null;
    } catch (err) {
      collectorError = err.message ?? String(err);
    }

    if ((i + 1) % 500 === 0 || i === firms.length - 1) {
      const pct = String(Math.round(((i + 1) / firms.length) * 100)).padStart(3);
      console.log(`  [${pct}%] ${i + 1}/${firms.length} complete`);
    }

    return {
      domain: firm.domain,
      success: !collectorError && !dbError,
      collectorError,
      dbError,
    };
  }, CONCURRENCY);

  const completedAt     = Date.now();
  const attempted       = results.length;
  const completed       = results.filter(r => r.success).length;
  const collectorErrors = results.filter(r => r.collectorError).length;
  const dbErrors        = results.filter(r => r.dbError).length;
  const successRate     = attempted > 0 ? (completed / attempted * 100).toFixed(3) : '0.000';
  const elapsedSec      = ((completedAt - startedAt) / 1000).toFixed(1);

  console.log(`\n${HR}`);
  console.log(' SUMMARY');
  console.log(JSON.stringify({
    signalId: 'SOT-CERTIFICATE-001',
    runId: certRunId,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    elapsedSec: Number(elapsedSec),
    attempted, completed, collectorErrors, dbErrors,
    successRate: Number(successRate),
  }, null, 2));
  console.log(`${HR}\n`);

  const failures = results.filter(r => !r.success);
  if (failures.length > 0) {
    console.log(`FAILURES (${failures.length} total, showing up to 25):`);
    console.log(JSON.stringify(failures.slice(0, 25), null, 2));
  }

  console.log(`\nCERT_RUN_ID=${certRunId}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
