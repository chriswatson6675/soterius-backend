'use strict';
// NOB-CAA-001R quality-score loader — mirrors nob-001r/load.js (SPF), nob-dkim-001r/load.js
// (DKIM) and nob-dmarc-001/load.js (DMARC). Scores the authoritative CAA baseline with the
// reference model CAA-QM-v1.0 (caa-quality.js) and loads it into signal_quality_caa.
//
// Guarantees persisted scores EXACTLY match the approved calibration (SLG-070 design,
// SLG-071 values): it IMPORTS and CALLS scorePopulation — it never re-implements the model.
//
// Reads the IMMUTABLE snapshot artefact (observations.ndjson, SHA-pinned in manifest.json)
// rather than re-querying the database, so the loaded scores are provably derived from the
// governed baseline. Emits quality-scores.ndjson + distribution.json and appends to
// signal_quality_caa.
//
// Commissioning requirements (SLG-072):
//   CR-1  the model reads caa_records only, case-folding tags → immune to collector defect D-2
//   CR-2  scorePopulation() resolves RFC 8659 §3 inheritance across the whole population
//   CR-3  a PROHIBITED domain is OBSERVED but UNCALIBRATED — this loader HALTS rather than
//         persisting it as a null score. (n = 0 on NOB-CAA-001R.)
//   CR-4  the M3 condition is persisted as a flag even though its factor is 1.00
//   CR-5  provenance is run_label + baseline window + observations SHA-256 (no run_id exists
//         on signal_facts_caa — SLG-066 G1)
//   CR-7  quality_version = 'CAA-QM-v1.0'
//
// Requires migration 029 applied. Append-only: INSERTs new rows, never UPDATEs or DELETEs,
// and never touches signal_facts_caa. Idempotency guard + --dry-run.
//
// Usage:
//   node backend/observatory/quality/nob-caa-001r/load.js --dry-run
//   node backend/observatory/quality/nob-caa-001r/load.js --confirm

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { scorePopulation, QUALITY_VERSION, MODEL_ID } = require('../caa-quality');

const DIR = __dirname;
const DRY = !process.argv.includes('--confirm');
const BATCH = 500;

const RUN_LABEL = 'NOB-CAA-001R';

// signal_facts_caa is a v0 schema with no run_id (SLG-066 G1), so the quality layer defines
// its own governed run identifier, deterministically from the label — as DKIM and DMARC do.
function deterministicRunId(label) {
  const h = crypto.createHash('sha256').update(label).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
const RUN_ID = deterministicRunId(RUN_LABEL);

function getClient() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required — check backend/.env');
  return createClient(url, key);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HR = '─'.repeat(76);

(async () => {
  console.log(`\n${HR}\n [P] CAA Quality Persistence Commissioning — ${RUN_LABEL}\n${HR}\n`);

  // ── 1. Load the immutable baseline artefact and verify its SHA ──────────────
  const ndjsonPath = path.join(DIR, 'observations.ndjson');
  const raw = fs.readFileSync(ndjsonPath, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const actualSha = sha256(raw);
  if (actualSha !== manifest.sha256.observations) {
    throw new Error(`baseline SHA mismatch — artefact has been altered\n  manifest ${manifest.sha256.observations}\n  actual   ${actualSha}`);
  }
  const rows = raw.trim().split('\n').map(JSON.parse);
  console.log(`  baseline        : ${manifest.run_label}  (${rows.length} observations)`);
  console.log(`  observations SHA: ${actualSha.slice(0, 24)}…  VERIFIED`);
  console.log(`  window          : ${manifest.window.after} → ${manifest.window.before}`);
  console.log(`  model           : ${MODEL_ID}  (quality_version ${QUALITY_VERSION})`);
  console.log(`  run_id          : ${RUN_ID}  (deterministic from run_label — CR-5)\n`);

  // ── 2. Score the whole population (CR-2: inheritance needs the population) ──
  const scored = scorePopulation(rows);

  // ── 3. CR-3 — PROHIBITED is observed but uncalibrated. HALT, never null-persist.
  const prohibited = [...scored.entries()].filter(([, r]) => r.reason === 'UNCALIBRATED_STATE_PROHIBITED');
  if (prohibited.length) {
    console.error(`\n  FATAL (CR-3): ${prohibited.length} domain(s) classify PROHIBITED — an OBSERVED state that`);
    console.error(`  CAA-QM-v1.0 does not calibrate (n = 0 at calibration; SLG-071 §5).`);
    console.error(`  Persisting them would conflate an observation with a non-observation (SLG-043 P1).`);
    console.error(`  A new model version is required (P9/P10). Domains: ${prohibited.slice(0, 10).map(([d]) => d).join(', ')}`);
    process.exit(1);
  }

  const scoredRows = [...scored.entries()].filter(([, r]) => r.scored);
  const unscored   = [...scored.entries()].filter(([, r]) => !r.scored);
  console.log(`  scored          : ${scoredRows.length}`);
  console.log(`  not scored      : ${unscored.length}  (unobserved — no row emitted, per P1)`);
  console.log(`  PROHIBITED      : 0  (uncalibrated; loader would have halted)\n`);

  // ── 4. Build rows + local evidence artefacts ───────────────────────────────
  const factsByDomain = new Map(rows.map(r => [r.domain, r]));
  const inserts = scoredRows.map(([domain, r]) => ({
    domain,
    run_id: RUN_ID,
    run_label: RUN_LABEL,
    baseline_sha256: actualSha,
    baseline_window_start: manifest.window.after,
    baseline_window_end: manifest.window.before,
    quality_version: QUALITY_VERSION,
    signal_version: factsByDomain.get(domain).signal_version,
    collected_at: factsByDomain.get(domain).collected_at,
    primary_score: r.primary,
    primary_label: r.primaryLabel,
    record_source: r.source,
    inherited_from: r.inheritedFrom,
    final_score: r.score,
    multipliers_applied: r.applied,
    m3_critical_unrecognised: r.flags.includes('M3_CRITICAL_UNRECOGNISED_TAG'),  // CR-4
  })).sort((a, b) => a.domain.localeCompare(b.domain));

  const scoresNd = inserts.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'quality-scores.ndjson'), scoresNd);

  const hist = {}, states = {};
  for (const r of inserts) { hist[r.final_score] = (hist[r.final_score] || 0) + 1; states[r.primary_label] = (states[r.primary_label] || 0) + 1; }
  const vals = inserts.map(r => r.final_score);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  const q = p => vals.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(p * vals.length) - 1)];
  const dist = {
    model: MODEL_ID, run_label: RUN_LABEL, run_id: RUN_ID,
    baseline_sha256: actualSha, window: manifest.window,
    population: rows.length, scored: inserts.length, not_scored: unscored.length,
    prohibited_uncalibrated: 0,
    primary_states: states,
    score_histogram: Object.fromEntries(Object.entries(hist).sort((a, b) => +a[0] - +b[0])),
    mean: +mean.toFixed(3), sd: +sd.toFixed(3),
    min: Math.min(...vals), q1: q(0.25), median: q(0.5), q3: q(0.75), max: Math.max(...vals),
    multipliers: {
      m1_wildcard_exceeds_base: inserts.filter(r => r.multipliers_applied.some(m => m.factor === 0.90)).length,
      m2_inoperative_element:   inserts.filter(r => r.multipliers_applied.some(m => m.factor === 0.95)).length,
      m3_flagged_uncalibrated:  inserts.filter(r => r.m3_critical_unrecognised).length,
    },
    inheritance_resolved: inserts.filter(r => r.record_source === 'ancestor').length,
    scores_sha256: sha256(scoresNd),
  };
  fs.writeFileSync(path.join(DIR, 'distribution.json'), JSON.stringify(dist, null, 2));
  console.log(`  histogram       : ${JSON.stringify(dist.score_histogram)}`);
  console.log(`  mean / sd       : ${dist.mean} / ${dist.sd}`);
  console.log(`  M1 / M2 / M3    : ${dist.multipliers.m1_wildcard_exceeds_base} / ${dist.multipliers.m2_inoperative_element} / ${dist.multipliers.m3_flagged_uncalibrated} (M3 flagged, factor 1.00)`);
  console.log(`  inherited (R4)  : ${dist.inheritance_resolved}`);
  console.log(`  scores SHA      : ${dist.scores_sha256.slice(0, 24)}…\n`);

  if (DRY) { console.log(`  DRY RUN — nothing written to the database. Pass --confirm to load.\n${HR}\n`); return; }

  // ── 5. Idempotency guard, then append ──────────────────────────────────────
  const sb = getClient();
  const { count, error: cErr } = await sb.from('signal_quality_caa')
    .select('id', { count: 'exact', head: true }).eq('run_label', RUN_LABEL);
  if (cErr) throw new Error(`count failed: ${cErr.message} (is migration 029 applied?)`);
  if (count > 0) { console.log(`  ${count} rows already present for ${RUN_LABEL} — refusing to duplicate. Nothing written.\n${HR}\n`); return; }

  let written = 0;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const chunk = inserts.slice(i, i + BATCH);
    const { error } = await sb.from('signal_quality_caa').insert(chunk);
    if (error) throw new Error(`insert failed at row ${i}: ${error.message}`);
    written += chunk.length;
    if (written % 5000 === 0 || written === inserts.length) console.log(`  loaded ${written}/${inserts.length}`);
  }
  console.log(`\n  COMMISSIONED — ${written} rows in signal_quality_caa (${RUN_LABEL})`);
  console.log(`  signal_facts_caa untouched (append-only quality layer).\n${HR}\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
