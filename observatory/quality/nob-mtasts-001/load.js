'use strict';
// NOB-MTASTS-001 quality-score loader — mirrors nob-dnssec-001/load.js (DNSSEC) and
// nob-caa-001r/load.js (CAA). Scores the NOB-MTASTS-001 national baseline with the
// reference model MTASTS-QM-v1.0 (mtasts-quality.js) and loads it into
// signal_quality_mtasts.
//
// Guarantees persisted scores EXACTLY match the calibrated model (SLG-087): it
// imports and calls scoreMtaStsQuality — it does not re-implement the calibration.
//
// Unlike DNSSEC (a single designated window with one observation per domain),
// signal_facts_mtasts is a v0 schema with MULTIPLE collection passes per domain
// across 2026-06-16..2026-07-07 and no run_id (SLG-083 §1). NOB-MTASTS-001 is
// defined as the most-recent observation per domain (DISTINCT ON (domain) ORDER BY
// collected_at DESC in SLG-083/084's analysis) — this loader reproduces that
// definition by paginating the full table and deduping client-side to the latest
// `collected_at` per domain, matching the SPF/DKIM/DMARC "dedupe to latest-
// observation-ever" precedent referenced in nob-dnssec-001/load.js.
//
// Requires migration 031 applied. Append-only: inserts new rows, never
// updates/deletes, never touches signal_facts_mtasts. Unknown observations
// (dns_sts_present null, or true with policy outcome undetermined) are NOT scored
// (no row emitted). Idempotency guard + --dry-run (default).
//
// Usage:
//   node backend/observatory/quality/nob-mtasts-001/load.js --dry-run
//   node backend/observatory/quality/nob-mtasts-001/load.js --confirm

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { scoreMtaStsQuality, QUALITY_VERSION, MODEL_ID } = require('../mtasts-quality');

const DIR = __dirname;
const DRY = !process.argv.includes('--confirm');
const BATCH = 500, PAGE = 1000;
const RUN_LABEL = 'NOB-MTASTS-001';

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
const COLS = 'id,domain,signal_version,collected_at,dns_sts_present,policy_present,' +
             'policy_parse_success,policy_mode,policy_max_age,policy_tls_valid,' +
             'policy_redirect_count,dns_multiple_sts_records,policy_unknown_fields';

(async () => {
  const sb = getClient();

  // ── Fetch every signal_facts_mtasts row, paginated by id ──────────────────────
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('signal_facts_mtasts').select(COLS)
      .order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }

  // ── Dedupe to the most-recent observation per domain (NOB-MTASTS-001 definition,
  // SLG-083 §1) — client-side equivalent of DISTINCT ON (domain) ORDER BY collected_at DESC.
  const latestByDomain = new Map();
  for (const r of all) {
    const prev = latestByDomain.get(r.domain);
    if (!prev || new Date(r.collected_at) > new Date(prev.collected_at)) latestByDomain.set(r.domain, r);
  }
  const rowsIn = [...latestByDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));

  const windowStart = rowsIn.reduce((min, r) => !min || r.collected_at < min ? r.collected_at : min, null);
  const windowEnd   = rowsIn.reduce((max, r) => !max || r.collected_at > max ? r.collected_at : max, null);

  console.log(`\n${RUN_LABEL} quality loader — model ${MODEL_ID}${DRY ? '  [DRY RUN — no DB writes]' : ''}`);
  console.log(`run_id ${RUN_ID}`);
  console.log(`signal_facts_mtasts total rows ${all.length}  →  distinct domains (latest-per-domain) ${rowsIn.length}`);
  console.log(`baseline window (min..max collected_at across latest-per-domain) ${windowStart} .. ${windowEnd}`);

  // ── Snapshot observations (immutable evidence) ──────────────────────────────
  const obsNd = rowsIn.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'observations.ndjson'), obsNd);

  // ── Score with the reference model ──────────────────────────────────────────
  const rows = [];
  let notScoredDnsUnobserved = 0;
  let notScoredPolicyUnobserved = 0;
  let calcFailures = 0;

  for (const o of rowsIn) {
    let r;
    try {
      r = scoreMtaStsQuality(o);
    } catch (e) {
      calcFailures++;
      console.error(`  CALC FAILURE  ${o.domain}: ${e.message}`);
      continue;
    }
    if (!r.scored) {
      if (r.reason === 'DNS_UNOBSERVED') notScoredDnsUnobserved++;
      else notScoredPolicyUnobserved++;
      continue;
    }
    rows.push({
      domain: o.domain, run_id: RUN_ID, run_label: RUN_LABEL,
      baseline_window_start: windowStart, baseline_window_end: windowEnd,
      quality_version: QUALITY_VERSION, signal_version: o.signal_version ?? 1,
      collected_at: o.collected_at,
      primary_score: r.primary, primary_label: r.primaryLabel,
      final_score: r.score, multipliers_applied: r.applied,
      uncalibrated_flags: r.flags,
    });
  }

  const scoresNd = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(DIR, 'quality-scores.ndjson'), scoresNd);

  const vals = rows.map(r => r.final_score).sort((a, b) => a - b);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const distinct = [...new Set(vals)].sort((a, b) => a - b);
  const stateHist = {};
  for (const r of rows) stateHist[r.primary_label] = (stateHist[r.primary_label] || 0) + 1;

  const manifest = {
    run_label: RUN_LABEL, run_id: RUN_ID, signal: 'SOT-MTASTS-001', model: MODEL_ID,
    baseline: 'NOB-MTASTS-001 national MTA-STS baseline (most-recent observation per domain)',
    baseline_window: { start: windowStart, end: windowEnd },
    population: rowsIn.length,
    scored: rows.length,
    not_scored_dns_unobserved: notScoredDnsUnobserved,
    not_scored_policy_unobserved: notScoredPolicyUnobserved,
    calc_failures: calcFailures,
    sha256: { observations: sha256(obsNd), quality_scores: sha256(scoresNd) },
    mean: +mean.toFixed(4), median: vals[Math.floor(vals.length/2)],
    distinct_values: distinct,
    primary_state_histogram: stateHist,
    provenance: 'Scored from signal_facts_mtasts (NOB-MTASTS-001, latest-per-domain) via mtasts-quality.js (MTASTS-QM-v1.0); SLG-086 design; SLG-087 calibration; SLG-088 commissioning.',
  };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`scored ${rows.length}   not-scored (DNS unobserved) ${notScoredDnsUnobserved}   not-scored (policy unobserved) ${notScoredPolicyUnobserved}   calc failures ${calcFailures}`);
  console.log(`final_score  mean ${mean.toFixed(4)}  median ${manifest.median}  min ${vals[0]}  max ${vals[vals.length-1]}  distinct ${JSON.stringify(distinct)}`);
  console.log(`primary states ${JSON.stringify(stateHist)}`);
  console.log(`wrote observations.ndjson (${rowsIn.length}) + quality-scores.ndjson (${rows.length}) + manifest.json`);

  if (calcFailures > 0) {
    console.error(`\n  ${calcFailures} calculation failures. Aborting — nothing loaded.\n`);
    process.exit(1);
  }

  // ── Preflight + idempotency guard ───────────────────────────────────────────
  const { error: tErr } = await sb.from('signal_quality_mtasts').select('id').limit(1);
  if (tErr) throw new Error(`signal_quality_mtasts not reachable (apply migration 031 first): ${tErr.message}`);
  const { count, error: gErr } = await sb.from('signal_quality_mtasts').select('id', { head: true, count: 'exact' }).eq('run_id', RUN_ID);
  if (gErr) throw new Error(`idempotency check failed: ${gErr.message}`);
  if (count > 0) { console.error(`\n  run_id ${RUN_ID} already has ${count} rows. Aborting — nothing loaded.\n`); process.exit(1); }

  if (DRY) { console.log('\nDRY RUN — table reachable; run not yet loaded. No rows written. Pass --confirm to load.\n'); return; }

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb.from('signal_quality_mtasts').insert(chunk);
    if (error) throw new Error(`insert failed at row ${i}: ${error.message}`);
    done += chunk.length;
    if (done % 5000 === 0 || done === rows.length) console.log(`  loaded ${done}/${rows.length}`);
  }
  console.log(`\nDONE — ${done} MTA-STS quality scores loaded for ${RUN_LABEL} (run_id ${RUN_ID}).\n`);
})().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
