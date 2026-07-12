'use strict';

// NOB-SECURITYTXT-001 — first national-scale Observatory run for
// SOT-SECURITYTXT-001 (Category C), per Founder directive 2026-07-09,
// following Stage 1 (SLG-123: collector reviewed, SUITABLE unmodified).
//
// Reuses the EXACT production collect+insert path — imports getClient() and
// runSecurityTxt() from run-all.js unmodified (no duplication, no drift) —
// against the full canonical ORG-AUTHORITY-001 VERIFIED-domain population,
// the same selection already used for NOB-TLS-001/NOB-CERTIFICATE-001-v2/
// NOB-SECURITYHEADERS-001.
//
// The collector itself (securitytxt-collector.js) is UNCHANGED by this run —
// SLG-123 (Stage 1) already reviewed it and found it suitable for national
// observation unmodified. This supersedes the prior 7,237-row cohort-scale
// dataset (HE-001/IF-001) for baseline/calibration purposes only — that data
// remains, untouched, append-only.
//
// Usage: node backend/collection/runs/if001/run-securitytxt-baseline.js
// Env:   CONCURRENCY (inherited from run-all.js's module-level default, 8)

const { randomUUID } = require('node:crypto');
const { getClient, runSecurityTxt } = require('./run-all');
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
  console.log(' NOB-SECURITYTXT-001 — national Observatory baseline');
  console.log(` Cohort: ${cohort.cohort_id}   n = ${cohort.n}`);
  console.log(` Selection ID: ${cohort.selection_id}`);
  console.log(` SOT-SECURITYTXT-001 run_id: ${runId}`);
  console.log(' RECORD this run_id in SLG-003 (Run Register) once collection completes.');
  console.log(`${HR}\n`);

  const { error: pingErr } = await supabase.from('signal_securitytxt_v1').select('id').limit(1);
  if (pingErr) {
    console.error(`  ERROR: Cannot reach Supabase — ${pingErr.message}`);
    process.exit(1);
  }
  console.log('  Supabase: connected\n');

  const stats = await runSecurityTxt(firms, supabase, runId, startedAt);

  console.log(`\n${HR}`);
  console.log(' SUMMARY');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`${HR}\n`);

  console.log(`RUN_ID=${runId}`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
