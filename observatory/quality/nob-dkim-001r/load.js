'use strict';
// NOB-DKIM-001R quality-score loader — mirrors nob-001r/load.js (SPF).
// Scores the authoritative validated baseline with the FROZEN DKIM-QM-v1.0 model
// (dkim-quality.js) from the immutable local artefacts (observations.ndjson +
// keys.ndjson), emits quality-scores.ndjson, and loads it into signal_quality_dkim.
//
// Guarantees persisted scores EXACTLY match the frozen model: it imports and calls
// scoreDkimQuality — it does not re-implement the calibration.
//
// Requires migration 027 (signal_quality_dkim) applied first. Append-only: inserts
// new rows, never updates/deletes. Unobserved observations (DNS failure) are NOT
// scored and emit no row, mirroring the SPF Unknown handling.
//
// Safety: preflight (table must exist) + idempotency guard (refuse if run_id
// already loaded). --dry-run writes quality-scores.ndjson + reports, writes no DB.
//
// Usage:
//   node backend/observatory/quality/nob-dkim-001r/load.js --dry-run
//   node backend/observatory/quality/nob-dkim-001r/load.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { scoreDkimQuality, QUALITY_VERSION, MODEL_ID } = require('../dkim-quality');

const DIR = __dirname;
const DRY = process.argv.includes('--dry-run');
const BATCH = 500;
const RUN_LABEL = 'NOB-DKIM-001R';

// Deterministic run_id for the NOB-DKIM-001R quality run (formatted as a UUID from
// sha256 of the run label — stable and reproducible; the v0 collection tables carry
// no run_id, so the quality layer defines its own governed run identifier).
function deterministicRunId(label) {
  const h = crypto.createHash('sha256').update(label).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}
const RUN_ID = deterministicRunId(RUN_LABEL);

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}
function readNd(f) {
  return fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ── Build score rows from the immutable artefacts via the frozen model ─────────
const obs = readNd('observations.ndjson');
const keys = readNd('keys.ndjson');
const keysByRun = new Map();
for (const k of keys) { if (!keysByRun.has(k.dkim_run_id)) keysByRun.set(k.dkim_run_id, []); keysByRun.get(k.dkim_run_id).push(k); }

const rows = [];
let notScored = 0;
for (const o of obs) {
  const facts = {
    dkim_present: o.dkim_present,
    dkim_collection_status: o.dkim_collection_status,
    dkim_keys: keysByRun.get(o.id) || [],
  };
  const r = scoreDkimQuality(facts);
  if (!r.scored) { notScored++; continue; }
  rows.push({
    domain: o.domain, run_id: RUN_ID, run_label: RUN_LABEL,
    quality_version: QUALITY_VERSION, signal_version: o.signal_version ?? 1,
    probe_set_version: o.dkim_probe_set_version ?? 1, collected_at: o.collected_at,
    primary_score: r.primary, primary_label: r.primaryLabel,
    max_key_bits: r.maxBits, final_score: r.score,
    multipliers_applied: r.applied,
  });
}

// Emit the repository artefact
fs.writeFileSync(path.join(DIR, 'quality-scores.ndjson'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

const vals = rows.map(r => r.final_score).sort((a,b)=>a-b);
const mean = vals.reduce((s,v)=>s+v,0)/vals.length;
const median = vals[Math.floor(vals.length/2)];
console.log(`\n${RUN_LABEL} quality loader — model ${MODEL_ID}${DRY ? '  [DRY RUN — no DB writes]' : ''}`);
console.log(`run_id ${RUN_ID}`);
console.log(`scored rows ${rows.length}   not-scored (unobserved) ${notScored}   distinct domains ${new Set(rows.map(r=>r.domain)).size}`);
console.log(`final_score  mean ${mean.toFixed(2)}  median ${median}  min ${vals[0]}  max ${vals[vals.length-1]}`);
console.log(`quality-scores.ndjson written (${rows.length} rows)`);

(async () => {
  const sb = getClient();
  const { error: tErr } = await sb.from('signal_quality_dkim').select('id').limit(1);
  if (tErr) throw new Error(`signal_quality_dkim not reachable (apply migration 027 first): ${tErr.message}`);

  const { count, error: gErr } = await sb.from('signal_quality_dkim')
    .select('id', { head: true, count: 'exact' }).eq('run_id', RUN_ID);
  if (gErr) throw new Error(`idempotency check failed: ${gErr.message}`);
  if (count > 0) { console.error(`\n  run_id ${RUN_ID} already has ${count} rows. Aborting — nothing loaded.\n`); process.exit(1); }

  if (DRY) { console.log('\nPreflight OK: table reachable; run not yet loaded. No rows written.\n'); return; }

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb.from('signal_quality_dkim').insert(chunk);
    if (error) throw new Error(`insert failed at row ${i}: ${error.message}`);
    done += chunk.length;
    if (done % 5000 === 0 || done === rows.length) console.log(`  loaded ${done}/${rows.length}`);
  }
  console.log(`\nDONE — ${done} DKIM quality scores loaded for ${RUN_LABEL} (run_id ${RUN_ID}).\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
