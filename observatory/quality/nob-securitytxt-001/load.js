'use strict';
// NOB-SECURITYTXT-001 quality-score loader — mirrors nob-tls-001/load.js and
// nob-mtasts-001/load.js. Scores the NOB-SECURITYTXT-001 national baseline
// with the reference model SECURITYTXT-QM-v1.0 (securitytxt-quality.js) and
// loads it into signal_quality_securitxt.
//
// Guarantees persisted scores EXACTLY match the calibrated model (SLG-128): it
// imports and calls scoreSecuritytxtQuality — it does not re-implement the
// calibration.
//
// signal_securitytxt_v1 IS a v1 schema with a run_id column (migration 013) —
// the baseline is selected by that exact collection run_id, not a timestamp
// window.
//
// Reads the baseline directly from signal_securitytxt_v1 (run_id-scoped, small
// page size since canonical_fetch/legacy_fetch carry raw_content up to 1MB
// each — the same large-JSONB-at-scale consideration already documented for
// this signal's Stage 3 reproducibility script), snapshots it to
// observations.ndjson (immutable evidence), emits quality-scores.ndjson +
// manifest.json, and loads signal_quality_securitytxt.
//
// Requires migration 034 applied. Append-only: inserts new rows, never
// updates/deletes. Unscored observations (NOT_DETERMINED) get NO row.
// Idempotency guard + --dry-run.
//
// Usage:
//   node backend/observatory/quality/nob-securitytxt-001/load.js --dry-run
//   node backend/observatory/quality/nob-securitytxt-001/load.js --confirm

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { scoreSecuritytxtQuality, QUALITY_VERSION, MODEL_ID } = require('../securitytxt-quality');

const DIR = __dirname;
const DRY = process.argv.includes('--dry-run');
const CONFIRM = process.argv.includes('--confirm');
const BATCH = 500, PAGE = 200;                     // small page — raw_content up to 1MB per fetch location
const RUN_LABEL = 'NOB-SECURITYTXT-001';

// The designated national collection run this baseline scores from (SLG-124 §2 /
// SLG-003 Run Register).
const SOURCE_RUN_ID = 'cb92dc04-c632-4cc8-a118-64adcadee8fd';

// Deterministic scoring run_id from the label (distinct from, but referencing,
// SOURCE_RUN_ID) — as for DKIM/DMARC/CAA/DNSSEC/MTA-STS/TLS/Certificate quality layers.
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
const COLS = 'domain,file_state,collected_at,canonical_fetch,legacy_fetch,canonical_parse,legacy_parse';

// Trim to exactly the fields the quality model reads + a light identity set —
// keeps observations.ndjson evidence-preserving (all scoring-relevant facts
// present) without re-snapshotting multi-hundred-KB raw_content bodies that
// signal_securitytxt_v1 itself already preserves as the immutable source.
function trimFetch(fetchObj) {
  if (!fetchObj) return null;
  return { fetch_state: fetchObj.fetch_state, content_type: fetchObj.content_type, http_status: fetchObj.http_status };
}
function trimParse(parseObj) {
  if (!parseObj) return null;
  const { contact, expires, encryption, canonical, preferred_languages, policy, acknowledgments, hiring, content_state } = parseObj;
  return { contact, expires, encryption, canonical, preferred_languages, policy, acknowledgments, hiring, content_state };
}

(async () => {
  const sb = getClient();

  // ── Fetch signal_securitytxt_v1, scoped to the exact collection run ────────
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('signal_securitytxt_v1').select(COLS)
      .eq('run_id', SOURCE_RUN_ID)
      .order('domain', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
    if (all.length % 2000 === 0) console.log(`  fetched ${all.length}...`);
  }

  // Verify no duplicate domains within the run.
  const byDomain = new Map();
  for (const r of all) {
    if (byDomain.has(r.domain)) throw new Error(`duplicate domain within run: ${r.domain}`);
    byDomain.set(r.domain, r);
  }
  const rowsIn = [...byDomain.values()];

  console.log(`\n${RUN_LABEL} quality loader — model ${MODEL_ID}${DRY ? '  [DRY RUN — no DB writes]' : ''}`);
  console.log(`scoring run_id ${RUN_ID}  (source collection run_id ${SOURCE_RUN_ID})`);
  console.log(`signal_securitytxt_v1 rows in run ${all.length}  →  distinct domains ${rowsIn.length}`);

  // ── Snapshot observations (immutable evidence — trimmed to scoring-relevant
  // facts; full raw_content remains preserved, untouched, in signal_securitytxt_v1
  // itself) ────────────────────────────────────────────────────────────────
  const trimmed = rowsIn.map(r => ({
    domain: r.domain, file_state: r.file_state, collected_at: r.collected_at,
    canonical_fetch: trimFetch(r.canonical_fetch), legacy_fetch: trimFetch(r.legacy_fetch),
    canonical_parse: trimParse(r.canonical_parse), legacy_parse: trimParse(r.legacy_parse),
  }));
  const obsNd = trimmed.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'observations.ndjson'), obsNd);

  // ── Score with the reference model ──────────────────────────────────────────
  const rows = [];
  const notScoredByReason = {};
  let calcFailures = 0;

  for (const o of rowsIn) {
    let r;
    try {
      r = scoreSecuritytxtQuality(o);
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
      primary_score: r.primary, primary_label: r.primaryLabel,
      final_score: r.score, evidence_flags: r.flags,
    });
  }

  const scoresNd = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'quality-scores.ndjson'), scoresNd);

  const vals = rows.map(r => r.final_score).sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const distinct = [...new Set(vals)].sort((a, b) => a - b);
  const notScoredTotal = Object.values(notScoredByReason).reduce((s, v) => s + v, 0);
  const primaryHistogram = rows.reduce((acc, r) => { acc[r.primary_label] = (acc[r.primary_label] ?? 0) + 1; return acc; }, {});
  const manifest = {
    run_label: RUN_LABEL, run_id: RUN_ID, source_run_id: SOURCE_RUN_ID,
    signal: 'SOT-SECURITYTXT-001', model: MODEL_ID,
    baseline: 'NOB-SECURITYTXT-001 national security.txt baseline',
    population: rowsIn.length,
    scored: rows.length,
    not_scored_total: notScoredTotal,
    not_scored_by_reason: notScoredByReason,
    calc_failures: calcFailures,
    primary_histogram: primaryHistogram,
    sha256: { observations: sha256(obsNd), quality_scores: sha256(scoresNd) },
    mean: +mean.toFixed(4), median: vals[Math.floor(vals.length/2)],
    distinct_values: distinct,
    provenance: 'Scored from signal_securitytxt_v1 (NOB-SECURITYTXT-001, run_id cb92dc04-c632-4cc8-a118-64adcadee8fd) via securitytxt-quality.js (SECURITYTXT-QM-v1.0); SLG-128 calibration.',
  };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`scored ${rows.length}   not-scored ${notScoredTotal} ${JSON.stringify(notScoredByReason)}   calc failures ${calcFailures}`);
  console.log(`final_score  mean ${mean.toFixed(4)}  median ${manifest.median}  min ${vals[0]}  max ${vals[vals.length-1]}  distinct ${JSON.stringify(distinct)}`);
  console.log(`primary histogram ${JSON.stringify(primaryHistogram)}`);
  console.log(`wrote observations.ndjson (${rowsIn.length}) + quality-scores.ndjson (${rows.length}) + manifest.json`);

  if (calcFailures > 0) {
    console.error(`\n  ${calcFailures} calculation failures. Aborting — nothing loaded.\n`);
    process.exit(1);
  }

  // ── Preflight + idempotency guard ───────────────────────────────────────────
  const { error: tErr } = await sb.from('signal_quality_securitytxt').select('id').limit(1);
  if (tErr) throw new Error(`signal_quality_securitytxt not reachable (apply migration 034 first): ${tErr.message}`);
  const { count, error: gErr } = await sb.from('signal_quality_securitytxt').select('id', { head: true, count: 'exact' }).eq('run_id', RUN_ID);
  if (gErr) throw new Error(`idempotency check failed: ${gErr.message}`);
  if (count > 0) { console.error(`\n  run_id ${RUN_ID} already has ${count} rows. Aborting — nothing loaded.\n`); process.exit(1); }

  if (DRY) { console.log('\nPreflight OK: table reachable; run not yet loaded. No rows written.\n'); return; }
  if (!CONFIRM) { console.log('\nPass --confirm to write. No rows written.\n'); return; }

  let done = 0;
  let persistFailures = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb.from('signal_quality_securitytxt').insert(chunk);
    if (error) { persistFailures += chunk.length; throw new Error(`insert failed at row ${i}: ${error.message}`); }
    done += chunk.length;
    if (done % 5000 === 0 || done === rows.length) console.log(`  loaded ${done}/${rows.length}`);
  }
  console.log(`\nDONE — ${done} Security.txt quality scores loaded for ${RUN_LABEL} (run_id ${RUN_ID}). Persistence failures: ${persistFailures}.\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
