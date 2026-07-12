'use strict';
// NOB-CERTIFICATE-001-v2 quality-score loader — mirrors nob-tls-001/load.js.
// Scores the corrected national baseline (SLG-104) with the reference model
// CERTIFICATE-QM-v1.0 (certificate-quality.js) and loads it into
// signal_quality_certificate.
//
// Guarantees persisted scores EXACTLY match the calibrated model (SLG-108): it
// imports and calls scoreCertificateQuality — it does not re-implement the
// calibration.
//
// signal_certificate_v1 IS a v1 schema with a run_id column (migration 015) —
// the baseline is selected by the exact collection run_id of the CORRECTED
// re-baseline (SLG-104), NOT the superseded pre-correction v1 run (SLG-102).
//
// Reads the baseline directly from signal_certificate_v1 (run_id-scoped),
// snapshots it to observations.ndjson (immutable evidence), emits
// quality-scores.ndjson + manifest.json, and loads signal_quality_certificate.
//
// Requires migration 033 applied. Append-only: inserts new rows, never
// updates/deletes. Unscored observations (NOT_OBSERVED / NO_CERTIFICATE_EVIDENCE
// / INVALID_OBSERVATION) get NO row. Idempotency guard + --dry-run.
//
// Usage:
//   node backend/observatory/quality/nob-certificate-001-v2/load.js --dry-run
//   node backend/observatory/quality/nob-certificate-001-v2/load.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { scoreCertificateQuality, QUALITY_VERSION, MODEL_ID } = require('../certificate-quality');

const DIR = __dirname;
const DRY = process.argv.includes('--dry-run');
const BATCH = 500, PAGE = 1000;
const RUN_LABEL = 'NOB-CERTIFICATE-001-v2';

// The corrected re-baseline collection run this loader scores from (SLG-104 §1).
// NOT SLG-102's superseded pre-correction run (5b034e5f-...).
const SOURCE_RUN_ID = '73808e28-eb01-4610-a5a9-de3765d6bad9';

// Deterministic scoring run_id from the label (distinct from, but referencing,
// SOURCE_RUN_ID) — as for DKIM/DMARC/CAA/DNSSEC/MTA-STS/TLS quality layers.
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
const COLS = 'domain,collected_at,endpoint_state,certificate_present,tls_error_code,leaf_days_remaining,leaf_issuer_cn,leaf_issuer_o,leaf_subject_cn,leaf_is_self_signed,leaf_is_wildcard,leaf_fingerprint_sha256,evidence';

(async () => {
  const sb = getClient();

  // ── Fetch signal_certificate_v1, scoped to the exact corrected collection run ──
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('signal_certificate_v1').select(COLS)
      .eq('run_id', SOURCE_RUN_ID)
      .order('domain', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }

  // Verify no duplicate domains within the run (run_id+domain uniqueness,
  // migration 015 — re-confirmed independently here).
  const byDomain = new Map();
  for (const r of all) {
    if (byDomain.has(r.domain)) throw new Error(`duplicate domain within run: ${r.domain}`);
    byDomain.set(r.domain, r);
  }
  const rowsIn = [...byDomain.values()];

  console.log(`\n${RUN_LABEL} quality loader — model ${MODEL_ID}${DRY ? '  [DRY RUN — no DB writes]' : ''}`);
  console.log(`scoring run_id ${RUN_ID}  (source collection run_id ${SOURCE_RUN_ID})`);
  console.log(`signal_certificate_v1 rows in run ${all.length}  →  distinct domains ${rowsIn.length}`);

  // ── Snapshot observations (immutable evidence) ──────────────────────────────
  const obsNd = rowsIn.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'observations.ndjson'), obsNd);

  // ── Score with the reference model ──────────────────────────────────────────
  const rows = [];
  const notScoredByReason = {};
  let calcFailures = 0;

  for (const o of rowsIn) {
    // Flatten the JSONB evidence block alongside the promoted scalar columns —
    // certificate-quality.js reads leaf_key_type/bits/curve and
    // leaf_lifetime_days, which live only in the evidence JSONB (not promoted
    // to scalar columns by migration 015).
    const facts = {
      endpoint_state: o.endpoint_state,
      certificate_present: o.certificate_present,
      tls_verification_result: o.evidence?.tls_verification_result,
      leaf_key_type: o.evidence?.leaf_key_type,
      leaf_key_bits: o.evidence?.leaf_key_bits,
      leaf_key_curve: o.evidence?.leaf_key_curve,
      leaf_is_wildcard: o.leaf_is_wildcard,
      leaf_is_self_signed: o.leaf_is_self_signed,
      leaf_lifetime_days: o.evidence?.leaf_lifetime_days,
    };

    let r;
    try {
      r = scoreCertificateQuality(facts);
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
      m1_key_strength: r.m1, m2_wildcard: r.m2, m3_lifetime: r.m3,
      final_score: r.score, evidence: r.evidence,
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
    signal: 'SOT-CERTIFICATE-001', model: MODEL_ID,
    baseline: 'NOB-CERTIFICATE-001-v2 corrected national certificate baseline',
    population: rowsIn.length,
    scored: rows.length,
    not_scored_total: notScoredTotal,
    not_scored_by_reason: notScoredByReason,
    calc_failures: calcFailures,
    sha256: { observations: sha256(obsNd), quality_scores: sha256(scoresNd) },
    mean: +mean.toFixed(4), median: vals[Math.floor(vals.length/2)],
    distinct_values: distinct,
    provenance: 'Scored from signal_certificate_v1 (NOB-CERTIFICATE-001-v2, run_id 73808e28-eb01-4610-a5a9-de3765d6bad9) via certificate-quality.js (CERTIFICATE-QM-v1.0); SLG-108 calibration, SLG-109 falsification.',
  };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`scored ${rows.length}   not-scored ${notScoredTotal} ${JSON.stringify(notScoredByReason)}   calc failures ${calcFailures}`);
  console.log(`final_score  mean ${mean.toFixed(4)}  median ${manifest.median}  min ${vals[0]}  max ${vals[vals.length-1]}  distinct ${JSON.stringify(distinct)}`);
  console.log(`wrote observations.ndjson (${rowsIn.length}) + quality-scores.ndjson (${rows.length}) + manifest.json`);

  if (calcFailures > 0) {
    console.error(`\n  ${calcFailures} calculation failures. Aborting — nothing loaded.\n`);
    process.exit(1);
  }

  // ── Preflight + idempotency guard ───────────────────────────────────────────
  const { error: tErr } = await sb.from('signal_quality_certificate').select('id').limit(1);
  if (tErr) throw new Error(`signal_quality_certificate not reachable (apply migration 033 first): ${tErr.message}`);
  const { count, error: gErr } = await sb.from('signal_quality_certificate').select('id', { head: true, count: 'exact' }).eq('run_id', RUN_ID);
  if (gErr) throw new Error(`idempotency check failed: ${gErr.message}`);
  if (count > 0) { console.error(`\n  run_id ${RUN_ID} already has ${count} rows. Aborting — nothing loaded.\n`); process.exit(1); }

  if (DRY) { console.log('\nPreflight OK: table reachable; run not yet loaded. No rows written.\n'); return; }

  let done = 0;
  let persistFailures = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb.from('signal_quality_certificate').insert(chunk);
    if (error) { persistFailures += chunk.length; throw new Error(`insert failed at row ${i}: ${error.message}`); }
    done += chunk.length;
    if (done % 5000 === 0 || done === rows.length) console.log(`  loaded ${done}/${rows.length}`);
  }
  console.log(`\nDONE — ${done} Certificate quality scores loaded for ${RUN_LABEL} (run_id ${RUN_ID}). Persistence failures: ${persistFailures}.\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
