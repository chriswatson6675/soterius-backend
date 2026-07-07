'use strict';
// NOB-001R DB loader — loads the persisted repository artefacts into the database.
//   observations.ndjson    → signal_facts_spf   (immutable observations)
//   quality-scores.ndjson  → signal_quality_spf (derived quality layer)
//
// Requires migration 026 (signal_quality_spf) applied first. Append-only: it
// inserts new rows and never updates/deletes — NOB-001 is untouched.
//
// Safety:
//   • Preflight requires BOTH tables to exist (no half-load).
//   • Idempotency guard: refuses to run if this run_id is already present.
//   • --dry-run performs only the read-only preflight (writes nothing).
//
// Usage:
//   node backend/observatory/quality/nob-001r/load.js --dry-run
//   node backend/observatory/quality/nob-001r/load.js

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');

const DIR = __dirname;
const DRY = process.argv.includes('--dry-run');
const BATCH = 500;

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — check backend/.env');
  return createClient(url, key);
}

function readNdjson(file) {
  return fs.readFileSync(path.join(DIR, file), 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// Returns the error object if the table is not reachable/does not exist, else null.
async function tableError(sb, table) {
  const { error } = await sb.from(table).select('id').limit(1);
  return error || null;
}

async function insertBatched(sb, table, rows) {
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb.from(table).insert(chunk);
    if (error) throw new Error(`${table} insert failed at row ${i}: ${error.message}`);
    done += chunk.length;
    if (done % 5000 === 0 || done === rows.length) console.log(`    ${table}: ${done}/${rows.length}`);
  }
  return done;
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const { run_id: runId, run_label: label } = manifest;
  console.log(`\nNOB-001R loader — ${label} (run_id ${runId})${DRY ? '   [DRY RUN — no writes]' : ''}`);

  const observations = readNdjson('observations.ndjson');
  const scores = readNdjson('quality-scores.ndjson');
  console.log(`  observations: ${observations.length}   quality scores: ${scores.length}`);

  const sb = getClient();

  // ── Preflight: both target tables must exist (never half-load) ──────────────
  const obsErr = await tableError(sb, 'signal_facts_spf');
  if (obsErr) throw new Error(`signal_facts_spf not reachable: ${obsErr.message}`);

  const qErr = await tableError(sb, 'signal_quality_spf');
  if (qErr) {
    console.error('\n  signal_quality_spf not found. Apply migration 026 first, then re-run:');
    console.error('    backend/db/migrations/026_signal_quality_spf.sql\n');
    process.exit(1);
  }

  // ── Idempotency guard: refuse to double-load this run ──────────────────────
  const { count, error: guardErr } = await sb
    .from('signal_quality_spf')
    .select('id', { head: true, count: 'exact' })
    .eq('run_id', runId);
  if (guardErr) throw new Error(`idempotency check failed: ${guardErr.message}`);
  if (count > 0) {
    console.error(`\n  run_id ${runId} already has ${count} rows in signal_quality_spf. Aborting — nothing loaded.\n`);
    process.exit(1);
  }

  if (DRY) {
    console.log('  Preflight OK: both tables reachable; run not yet loaded. No rows written.\n');
    return;
  }

  console.log('  Loading observations  → signal_facts_spf ...');
  const nObs = await insertBatched(sb, 'signal_facts_spf', observations);
  console.log('  Loading quality scores → signal_quality_spf ...');
  const nQ = await insertBatched(sb, 'signal_quality_spf', scores);

  console.log(`\nDONE — ${nObs} observations + ${nQ} quality scores loaded for ${label}. NOB-001 untouched.\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
