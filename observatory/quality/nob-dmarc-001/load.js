'use strict';
// NOB-DMARC-001 quality-score loader — mirrors nob-001r/load.js (SPF) and
// nob-dkim-001r/load.js (DKIM). Scores the NOB-001 national DMARC baseline with
// the reference model DMARC-QM-v1.0 (dmarc-quality.js) and loads it into
// signal_quality_dmarc.
//
// Guarantees persisted scores EXACTLY match the calibrated model (SLG-060): it
// imports and calls scoreDmarcQuality — it does not re-implement the calibration.
//
// Reads the baseline directly from signal_facts_dmarc (latest observation per
// domain), snapshots it to observations.ndjson (immutable evidence), emits
// quality-scores.ndjson + manifest.json, and loads signal_quality_dmarc.
//
// Requires migration 028 applied. Append-only: inserts new rows, never
// updates/deletes. Unknown observations (DNS failure) are NOT scored (no row),
// mirroring SPF Unknown / DKIM unobserved. Idempotency guard + --dry-run.
//
// Usage:
//   node backend/observatory/quality/nob-dmarc-001/load.js --dry-run
//   node backend/observatory/quality/nob-dmarc-001/load.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { scoreDmarcQuality, QUALITY_VERSION, MODEL_ID } = require('../dmarc-quality');

const DIR = __dirname;
const DRY = process.argv.includes('--dry-run');
const BATCH = 500, PAGE = 1000;
const RUN_LABEL = 'NOB-DMARC-001';

// Deterministic run_id from the label (v0 collection tables carry no run_id, so the
// quality layer defines its own governed run identifier — as for DKIM).
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
const COLS = 'id,domain,signal_version,collected_at,dmarc_present,dmarc_collection_error,dmarc_multiple_records,dmarc_parse_success,dmarc_policy,dmarc_subdomain_policy,dmarc_pct';

(async () => {
  const sb = getClient();

  // ── Fetch signal_facts_dmarc, paginated by the UNIQUE id (stable pagination) ──
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('signal_facts_dmarc').select(COLS).order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }
  // latest observation per domain
  const latestByDomain = new Map();
  for (const r of all) {
    const cur = latestByDomain.get(r.domain);
    if (!cur || r.collected_at > cur.collected_at) latestByDomain.set(r.domain, r);
  }
  const latest = [...latestByDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  console.log(`\n${RUN_LABEL} quality loader — model ${MODEL_ID}${DRY ? '  [DRY RUN — no DB writes]' : ''}`);
  console.log(`run_id ${RUN_ID}`);
  console.log(`signal_facts_dmarc rows ${all.length}  →  latest-per-domain ${latest.length}`);

  // ── Snapshot observations (immutable evidence) ──────────────────────────────
  const obsNd = latest.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'observations.ndjson'), obsNd);

  // ── Score with the reference model ──────────────────────────────────────────
  const rows = [];
  let notScored = 0;
  for (const o of latest) {
    const r = scoreDmarcQuality(o);
    if (!r.scored) { notScored++; continue; }
    rows.push({
      domain: o.domain, run_id: RUN_ID, run_label: RUN_LABEL,
      quality_version: QUALITY_VERSION, signal_version: o.signal_version ?? 1,
      collected_at: o.collected_at,
      primary_score: r.primary, primary_label: r.primaryLabel,
      dmarc_policy: ['reject','quarantine','none'].includes(r.primaryLabel) ? r.primaryLabel : null,
      final_score: r.score, multipliers_applied: r.applied,
    });
  }
  const scoresNd = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'quality-scores.ndjson'), scoresNd);

  const vals = rows.map(r => r.final_score).sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const manifest = {
    run_label: RUN_LABEL, run_id: RUN_ID, signal: 'SOT-DMARC-001', model: MODEL_ID,
    baseline: 'NOB-001 national DMARC collection', population: latest.length,
    scored: rows.length, not_scored_unknown: notScored,
    sha256: { observations: sha256(obsNd), quality_scores: sha256(scoresNd) },
    mean: +mean.toFixed(2), median: vals[Math.floor(vals.length/2)],
    provenance: 'Scored from signal_facts_dmarc latest-per-domain via dmarc-quality.js (DMARC-QM-v1.0); SLG-060 calibration; SLG-062 commissioning.',
  };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`scored ${rows.length}   not-scored (unknown) ${notScored}   distinct domains ${new Set(rows.map(r=>r.domain)).size}`);
  console.log(`final_score  mean ${mean.toFixed(2)}  median ${manifest.median}  min ${vals[0]}  max ${vals[vals.length-1]}`);
  console.log(`wrote observations.ndjson (${latest.length}) + quality-scores.ndjson (${rows.length}) + manifest.json`);

  // ── Preflight + idempotency guard ───────────────────────────────────────────
  const { error: tErr } = await sb.from('signal_quality_dmarc').select('id').limit(1);
  if (tErr) throw new Error(`signal_quality_dmarc not reachable (apply migration 028 first): ${tErr.message}`);
  const { count, error: gErr } = await sb.from('signal_quality_dmarc').select('id', { head: true, count: 'exact' }).eq('run_id', RUN_ID);
  if (gErr) throw new Error(`idempotency check failed: ${gErr.message}`);
  if (count > 0) { console.error(`\n  run_id ${RUN_ID} already has ${count} rows. Aborting — nothing loaded.\n`); process.exit(1); }

  if (DRY) { console.log('\nPreflight OK: table reachable; run not yet loaded. No rows written.\n'); return; }

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb.from('signal_quality_dmarc').insert(chunk);
    if (error) throw new Error(`insert failed at row ${i}: ${error.message}`);
    done += chunk.length;
    if (done % 5000 === 0 || done === rows.length) console.log(`  loaded ${done}/${rows.length}`);
  }
  console.log(`\nDONE — ${done} DMARC quality scores loaded for ${RUN_LABEL} (run_id ${RUN_ID}).\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
