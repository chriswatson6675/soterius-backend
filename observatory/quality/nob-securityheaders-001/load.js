'use strict';
// NOB-SECURITYHEADERS-001 quality-score loader — mirrors nob-tls-001/load.js.
// Scores the NOB-SECURITYHEADERS-001 national baseline with the reference model
// SECURITYHEADERS-QM-v1.0 (securityheaders-quality.js) and loads it into
// signal_quality_securityheaders.
//
// This is the deferred [P] persistence commissioning for SECURITYHEADERS-QM-v1.0
// (SLG-120 froze the model but included no persistence stage). It changes nothing
// in the frozen model: it imports and calls scoreSecurityHeadersQuality — it does
// not re-implement the calibration. Persisted values EXACTLY equal the frozen
// model's output.
//
// signal_securityheaders_v1 IS a v1 schema with a run_id column (migration 014) —
// the baseline is selected by that exact collection run_id, not a timestamp.
//
// Requires migration 035 applied. Append-only: inserts new rows, never
// updates/deletes. Unscored observations (endpoint_state != RESPONSE_OBSERVED →
// OBSERVATION_INCOMPLETE) get NO row (Unknown ≠ Absent). Idempotency guard + --dry-run.
//
// Usage:
//   node backend/observatory/quality/nob-securityheaders-001/load.js --dry-run
//   node backend/observatory/quality/nob-securityheaders-001/load.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { scoreSecurityHeadersQuality, QUALITY_VERSION, MODEL_ID } = require('../securityheaders-quality');

const DIR = __dirname;
const DRY = process.argv.includes('--dry-run');
const BATCH = 500, PAGE = 1000;
const RUN_LABEL = 'NOB-SECURITYHEADERS-001';

// The designated national collection run this baseline scores from (SLG-113 /
// SLG-003 Run Register) — 17,055 rows, 14,940 RESPONSE_OBSERVED, 2026-07-09.
const SOURCE_RUN_ID = '34fa4a90-dd4e-4497-8a01-0d38f9b00134';

// Deterministic scoring run_id from the label (distinct from, but referencing,
// SOURCE_RUN_ID) — as for the sibling quality layers.
function deterministicRunId(label) {
  const h = crypto.createHash('sha256').update(label).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}
const RUN_ID = deterministicRunId(RUN_LABEL);

function getClient() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const COLS = 'domain,collected_at,endpoint_state,header_inventory';

(async () => {
  const sb = getClient();

  // ── Fetch signal_securityheaders_v1, scoped to the exact collection run ─────
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('signal_securityheaders_v1').select(COLS)
      .eq('run_id', SOURCE_RUN_ID)
      .order('domain', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }

  // Verify no duplicate domains within the run (run_id+domain unique per mig 014).
  const byDomain = new Map();
  for (const r of all) {
    if (byDomain.has(r.domain)) throw new Error(`duplicate domain within run: ${r.domain}`);
    byDomain.set(r.domain, r);
  }
  const rowsIn = [...byDomain.values()];

  console.log(`\n${RUN_LABEL} quality loader — model ${MODEL_ID}${DRY ? '  [DRY RUN — no DB writes]' : ''}`);
  console.log(`scoring run_id ${RUN_ID}  (source collection run_id ${SOURCE_RUN_ID})`);
  console.log(`signal_securityheaders_v1 rows in run ${all.length}  →  distinct domains ${rowsIn.length}`);

  // ── Snapshot observations (immutable evidence) ──────────────────────────────
  const obsNd = rowsIn.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'observations.ndjson'), obsNd);

  // ── Score with the reference model ──────────────────────────────────────────
  const rows = [];
  const notScoredByReason = {};
  let calcFailures = 0;

  for (const o of rowsIn) {
    let r;
    try {
      r = scoreSecurityHeadersQuality(o);
    } catch (e) {
      calcFailures++;
      console.error(`  CALC FAILURE  ${o.domain}: ${e.message}`);
      continue;
    }
    if (!r.scored) {
      notScoredByReason[r.reason] = (notScoredByReason[r.reason] ?? 0) + 1;
      continue;
    }
    rows.push({
      domain: o.domain, run_id: RUN_ID, run_label: RUN_LABEL, source_run_id: SOURCE_RUN_ID,
      quality_version: QUALITY_VERSION, signal_version: '1.0.0',
      collected_at: o.collected_at,
      final_score: r.score, breakdown: r.breakdown, evidence: r.evidence, evidence_flags: r.flags,
    });
  }

  const scoresNd = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'quality-scores.ndjson'), scoresNd);

  const vals = rows.map(r => r.final_score).sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const distinct = [...new Set(vals)].sort((a, b) => a - b);
  const notScoredTotal = Object.values(notScoredByReason).reduce((s, v) => s + v, 0);
  const manifest = {
    run_label: RUN_LABEL, run_id: RUN_ID, source_run_id: SOURCE_RUN_ID,
    signal: 'SOT-SECURITYHEADERS-001', model: MODEL_ID,
    baseline: 'NOB-SECURITYHEADERS-001 national Security Headers baseline',
    population: rowsIn.length,
    scored: rows.length,
    not_scored_total: notScoredTotal,
    not_scored_by_reason: notScoredByReason,
    calc_failures: calcFailures,
    sha256: { observations: sha256(obsNd), quality_scores: sha256(scoresNd) },
    mean: +mean.toFixed(4), median: vals[Math.floor(vals.length/2)],
    distinct_values: distinct.length,
    provenance: 'Scored from signal_securityheaders_v1 (NOB-SECURITYHEADERS-001, run_id 34fa4a90-dd4e-4497-8a01-0d38f9b00134) via securityheaders-quality.js (SECURITYHEADERS-QM-v1.0); SLG-117 calibration, SLG-120 freeze.',
  };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`scored ${rows.length}   not-scored ${notScoredTotal} ${JSON.stringify(notScoredByReason)}   calc failures ${calcFailures}`);
  console.log(`final_score  mean ${mean.toFixed(4)}  median ${manifest.median}  min ${vals[0]}  max ${vals[vals.length-1]}  distinct ${distinct.length}`);
  console.log(`wrote observations.ndjson (${rowsIn.length}) + quality-scores.ndjson (${rows.length}) + manifest.json`);

  if (calcFailures > 0) {
    console.error(`\n  ${calcFailures} calculation failures. Aborting — nothing loaded.\n`);
    process.exit(1);
  }

  // ── Preflight + idempotency guard ───────────────────────────────────────────
  const { error: tErr } = await sb.from('signal_quality_securityheaders').select('id').limit(1);
  if (tErr) throw new Error(`signal_quality_securityheaders not reachable (apply migration 035 first): ${tErr.message}`);
  const { count, error: gErr } = await sb.from('signal_quality_securityheaders').select('id', { head: true, count: 'exact' }).eq('run_id', RUN_ID);
  if (gErr) throw new Error(`idempotency check failed: ${gErr.message}`);
  if (count > 0) { console.error(`\n  run_id ${RUN_ID} already has ${count} rows. Aborting — nothing loaded.\n`); process.exit(1); }

  if (DRY) { console.log('\nPreflight OK: table reachable; run not yet loaded. No rows written.\n'); return; }

  let done = 0;
  let persistFailures = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb.from('signal_quality_securityheaders').insert(chunk);
    if (error) { persistFailures += chunk.length; throw new Error(`insert failed at row ${i}: ${error.message}`); }
    done += chunk.length;
    if (done % 5000 === 0 || done === rows.length) console.log(`  loaded ${done}/${rows.length}`);
  }
  console.log(`\nDONE — ${done} Security Headers quality scores loaded for ${RUN_LABEL} (run_id ${RUN_ID}). Persistence failures: ${persistFailures}.\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
