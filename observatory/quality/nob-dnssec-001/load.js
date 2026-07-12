'use strict';
// NOB-DNSSEC-001 quality-score loader — mirrors nob-dmarc-001/load.js (DMARC) and
// nob-caa-001r/load.js (CAA). Scores the NOB-DNSSEC-001 national baseline with the
// reference model DNSSEC-QM-v1.0 (dnssec-quality.js) and loads it into
// signal_quality_dnssec.
//
// Guarantees persisted scores EXACTLY match the calibrated model (SLG-080): it
// imports and calls scoreDnssecQuality — it does not re-implement the calibration.
//
// Unlike DMARC/SPF/DKIM (which dedupe to latest-observation-ever), DNSSEC's baseline
// is a DESIGNATED WINDOW, not the whole table: signal_facts_dnssec holds three earlier
// cohort-scale episodes (2026-06-17/-06-19/-06-30) alongside the national run, and only
// the national window is NOB-DNSSEC-001 (SLG-076 §3.1). Rows are selected by that
// window, not by latest-per-domain-across-all-time.
//
// Reads the baseline directly from signal_facts_dnssec (window-scoped), snapshots it
// to observations.ndjson (immutable evidence), emits quality-scores.ndjson + manifest.json,
// and loads signal_quality_dnssec.
//
// Requires migration 030 applied. Append-only: inserts new rows, never updates/deletes.
// Unknown observations (either axis unobserved) and the empirically-impossible
// DS-without-DNSKEY state are NOT scored (no row). Idempotency guard + --dry-run.
//
// Usage:
//   node backend/observatory/quality/nob-dnssec-001/load.js --dry-run
//   node backend/observatory/quality/nob-dnssec-001/load.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { scoreDnssecQuality, QUALITY_VERSION, MODEL_ID } = require('../dnssec-quality');

const DIR = __dirname;
const DRY = process.argv.includes('--dry-run');
const BATCH = 500, PAGE = 1000;
const RUN_LABEL = 'NOB-DNSSEC-001';

// The designated national baseline window (SLG-076 §3.1 / SLG-003 Run Register).
const BASELINE_WINDOW_START = '2026-07-06T23:57:33.368Z';
const BASELINE_WINDOW_END   = '2026-07-07T00:08:10.030Z';

// Deterministic run_id from the label (v0 collection tables carry no run_id, so the
// quality layer defines its own governed run identifier — as for DKIM/DMARC/CAA).
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
const COLS = 'id,domain,signal_version,collected_at,dns_ds_present,ds_collection_error,ds_digest_types,dns_dnskey_present,dnskey_collection_error,dnskey_algorithms';

(async () => {
  const sb = getClient();

  // ── Fetch signal_facts_dnssec, window-scoped, paginated by id (stable pagination) ──
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('signal_facts_dnssec').select(COLS)
      .gte('collected_at', BASELINE_WINDOW_START)
      .lte('collected_at', BASELINE_WINDOW_END)
      .order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }

  // Verify no duplicate domains within the window (NOB-DNSSEC-001 is established as
  // exactly one observation per domain — SLG-076 §3.1). Fail loudly, not silently, if
  // this ever ceases to hold.
  const byDomain = new Map();
  for (const r of all) {
    if (byDomain.has(r.domain)) throw new Error(`duplicate domain within baseline window: ${r.domain}`);
    byDomain.set(r.domain, r);
  }
  const rowsIn = [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));

  console.log(`\n${RUN_LABEL} quality loader — model ${MODEL_ID}${DRY ? '  [DRY RUN — no DB writes]' : ''}`);
  console.log(`run_id ${RUN_ID}`);
  console.log(`baseline window ${BASELINE_WINDOW_START} .. ${BASELINE_WINDOW_END}`);
  console.log(`signal_facts_dnssec rows in window ${all.length}  →  distinct domains ${rowsIn.length}`);

  // ── Snapshot observations (immutable evidence) ──────────────────────────────
  const obsNd = rowsIn.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'observations.ndjson'), obsNd);

  // ── Score with the reference model ──────────────────────────────────────────
  const rows = [];
  let notScoredIncomplete = 0;
  let notScoredAnomalous = 0;
  let calcFailures = 0;
  const anomalousDomains = [];

  for (const o of rowsIn) {
    let r;
    try {
      r = scoreDnssecQuality(o);
    } catch (e) {
      calcFailures++;
      console.error(`  CALC FAILURE  ${o.domain}: ${e.message}`);
      continue;
    }
    if (!r.scored) {
      if (r.reason === 'ANOMALOUS_STATE_DS_WITHOUT_DNSKEY') { notScoredAnomalous++; anomalousDomains.push(o.domain); }
      else notScoredIncomplete++;
      continue;
    }
    rows.push({
      domain: o.domain, run_id: RUN_ID, run_label: RUN_LABEL,
      baseline_window_start: BASELINE_WINDOW_START, baseline_window_end: BASELINE_WINDOW_END,
      quality_version: QUALITY_VERSION, signal_version: o.signal_version ?? 1,
      collected_at: o.collected_at,
      primary_score: r.primary, primary_label: r.primaryLabel,
      final_score: r.score, multipliers_applied: r.applied,
      legacy_dnskey_algorithm_flag: r.flags.includes('UNCALIBRATED_LEGACY_DNSKEY_ALGORITHM'),
    });
  }

  const scoresNd = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'quality-scores.ndjson'), scoresNd);

  const vals = rows.map(r => r.final_score).sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const distinct = [...new Set(vals)].sort((a, b) => a - b);
  const manifest = {
    run_label: RUN_LABEL, run_id: RUN_ID, signal: 'SOT-DNSSEC-001', model: MODEL_ID,
    baseline: 'NOB-DNSSEC-001 national DNSSEC baseline',
    baseline_window: { start: BASELINE_WINDOW_START, end: BASELINE_WINDOW_END },
    population: rowsIn.length,
    scored: rows.length,
    not_scored_incomplete: notScoredIncomplete,
    not_scored_anomalous: notScoredAnomalous,
    anomalous_domains: anomalousDomains,
    calc_failures: calcFailures,
    sha256: { observations: sha256(obsNd), quality_scores: sha256(scoresNd) },
    mean: +mean.toFixed(4), median: vals[Math.floor(vals.length/2)],
    distinct_values: distinct,
    provenance: 'Scored from signal_facts_dnssec (NOB-DNSSEC-001 window) via dnssec-quality.js (DNSSEC-QM-v1.0); SLG-080 calibration; SLG-081 commissioning.',
  };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`scored ${rows.length}   not-scored (incomplete) ${notScoredIncomplete}   not-scored (anomalous) ${notScoredAnomalous}   calc failures ${calcFailures}`);
  console.log(`final_score  mean ${mean.toFixed(4)}  median ${manifest.median}  min ${vals[0]}  max ${vals[vals.length-1]}  distinct ${JSON.stringify(distinct)}`);
  console.log(`wrote observations.ndjson (${rowsIn.length}) + quality-scores.ndjson (${rows.length}) + manifest.json`);

  if (calcFailures > 0) {
    console.error(`\n  ${calcFailures} calculation failures. Aborting — nothing loaded.\n`);
    process.exit(1);
  }

  // ── Preflight + idempotency guard ───────────────────────────────────────────
  const { error: tErr } = await sb.from('signal_quality_dnssec').select('id').limit(1);
  if (tErr) throw new Error(`signal_quality_dnssec not reachable (apply migration 030 first): ${tErr.message}`);
  const { count, error: gErr } = await sb.from('signal_quality_dnssec').select('id', { head: true, count: 'exact' }).eq('run_id', RUN_ID);
  if (gErr) throw new Error(`idempotency check failed: ${gErr.message}`);
  if (count > 0) { console.error(`\n  run_id ${RUN_ID} already has ${count} rows. Aborting — nothing loaded.\n`); process.exit(1); }

  if (DRY) { console.log('\nPreflight OK: table reachable; run not yet loaded. No rows written.\n'); return; }

  let done = 0;
  let persistFailures = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb.from('signal_quality_dnssec').insert(chunk);
    if (error) { persistFailures += chunk.length; throw new Error(`insert failed at row ${i}: ${error.message}`); }
    done += chunk.length;
    if (done % 5000 === 0 || done === rows.length) console.log(`  loaded ${done}/${rows.length}`);
  }
  console.log(`\nDONE — ${done} DNSSEC quality scores loaded for ${RUN_LABEL} (run_id ${RUN_ID}). Persistence failures: ${persistFailures}.\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
