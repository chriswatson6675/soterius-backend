'use strict';

// NOB-SECURITYHEADERS-001 — first national-scale Observatory run for
// SOT-SECURITYHEADERS-001 (Category C), per Founder directive 2026-07-09.
//
// Reuses the EXACT production collect+insert path — imports getClient() and
// runSecurityHeaders() from run-all.js unmodified (no duplication, no drift;
// per that module's own "exported so an operational retry pass can re-collect
// ... using the EXACT production collect+insert functions" comment) — against
// the full canonical ORG-AUTHORITY-001 VERIFIED-domain population, the same
// selection already used for NOB-TLS-001/NOB-CERTIFICATE-001-v2.
//
// The collector itself (securityheaders-collector.js) is UNCHANGED by this
// run — SLG-112 (Stage 1) already reviewed it and found it suitable for
// national observation unmodified.
//
// Usage: node backend/collection/runs/if001/run-securityheaders-baseline.js
// Env:   CONCURRENCY (inherited from run-all.js's module-level default, 8)

const { randomUUID } = require('node:crypto');
const { getClient, runSecurityHeaders } = require('./run-all');
const { loadOrganisations } = require('../../../acquisition/providers/organisation-provider');

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
  const runId = randomUUID();
  const startedAt = Date.now();

  console.log(`\n${HR}`);
  console.log(' NOB-SECURITYHEADERS-001 — national Observatory baseline');
  console.log(` Cohort: ${cohort.cohort_id}   n = ${cohort.n}`);
  console.log(` Selection ID: ${cohort.selection_id}`);
  console.log(` SOT-SECURITYHEADERS-001 run_id: ${runId}`);
  console.log(' RECORD this run_id in SLG-003 (Run Register) once collection completes.');
  console.log(`${HR}\n`);

  const { error: pingErr } = await supabase.from('signal_securityheaders_v1').select('id').limit(1);
  if (pingErr) {
    console.error(`  ERROR: Cannot reach Supabase — ${pingErr.message}`);
    process.exit(1);
  }
  console.log('  Supabase: connected\n');

  const stats = await runSecurityHeaders(firms, supabase, runId, startedAt);

  console.log(`\n${HR}`);
  console.log(' SUMMARY');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`${HR}\n`);

  console.log(`RUN_ID=${runId}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
