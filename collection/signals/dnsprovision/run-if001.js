'use strict';
// RUN-DNSPROVISION-001 — first operational Category F cohort collection.
// Executes SOT-DNSPROVISION-001 across the full IF-001 population (frozen DPR-DATA-001 v1.0).
// Preserves Layer-A evidence; computes Assessment-layer population statistics (descriptive only —
// NO risk/resilience/trust scoring). DPR-DATA-001 used exclusively; PSL version recorded.

const fs = require('fs');
const path = require('path');
const signal = require('./dnsprovision-signal');
const V = require('./validate');

const MANIFEST = path.join(__dirname, '..', '..', 'if001-full', 'cohort-manifest.json');
const OUT_ROWS = path.join(__dirname, 'if001-dnsprovision-results.json');
const CONCURRENCY = 24;

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const idx = i++; if (idx >= items.length) break;
      out[idx] = await worker(items[idx], idx);
      if (idx % 100 === 0) process.stderr.write(`  ..${idx}/${items.length}\r`);
    }
  }));
  return out;
}

function tally(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function sortDesc(map) { return [...map.entries()].sort((a, b) => b[1] - a[1]); }
function pct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '0%'; }

(async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const firms = manifest.firms.filter(f => f.domain);
  const runCtx = signal.prepareRun();
  console.log(`# RUN-DNSPROVISION-001 — IF-001 cohort collection`);
  console.log(`# cohort=${manifest.cohort_id} firms=${firms.length} | dataset=${runCtx.dataset.dataset_id} v${runCtx.dataset.dataset_version} (${runCtx.dataset.status}) | psl=${require('./psl-processor').PSL_VERSION}`);
  console.log(`# dataset ns_zones=${runCtx.dataset.entries.reduce((a, e) => a + e.ns_zones.length, 0)} | duplicate defects=${runCtx.duplicates.length}\n`);

  const t0 = Date.now();
  const rows = await pool(firms, CONCURRENCY, async (f) => {
    try { return await signal.collectDomain(f.domain, runCtx); }
    catch (e) { return { subject_domain: f.domain, collection_status: 'COLLECT_ERROR', error: e.code, ns_zones: [], attributions: [], dns_provision_model: null, distinct_dns_operator_count: 0 }; }
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(OUT_ROWS, JSON.stringify(rows, null, 1));

  // ── Collection outcomes ───────────────────────────────────────────────
  const status = new Map();
  for (const r of rows) tally(status, r.collection_status || 'OK');
  const resolved = rows.filter(r => (r.ns_hostnames || []).length > 0);
  const failed = rows.length - resolved.length;

  // ── Validation (schema/boundary all rows; reproducibility on sample) ───
  let schemaFail = 0, boundaryViol = 0;
  for (const r of resolved) { if (V.validateSchema(r).length) schemaFail++; boundaryViol += V.validateBoundary(r).length; }
  let reproFail = 0;
  const sample = resolved.slice(0, 30);
  for (const r of sample) {
    const r2 = await signal.collectDomain(r.subject_domain, runCtx);
    if (!V.reproducible({ ...r, collection_timestamp: 'x' }, { ...r2, collection_timestamp: 'x' })) reproFail++;
  }

  // ── Attribution / population distributions (Assessment-layer) ─────────
  const model = new Map(), primaryProvider = new Map(), anyProvider = new Map(), statusZone = new Map();
  const unmappedZones = new Map();
  let multiProvider = 0, selfOperated = 0, managed = 0, undetermined = 0;
  for (const r of resolved) {
    tally(model, r.dns_provision_model);
    if (r.multi_provider) multiProvider++;
    if (r.dns_provision_model === 'SELF_OPERATED') selfOperated++;
    if (r.dns_provision_model === 'THIRD_PARTY_SINGLE' || r.dns_provision_model === 'THIRD_PARTY_MULTI') managed++;
    if (r.dns_provision_model === 'UNDETERMINED') undetermined++;
    if (r.primary_dns_provider_id) tally(primaryProvider, r.primary_dns_provider_id);
    const provs = new Set();
    for (const a of r.attributions) {
      tally(statusZone, a.match_status);
      if (a.match_status === 'MAPPED') provs.add(a.provider_id + ' ' + a.provider_name);
      if (a.match_status === 'UNMAPPED') tally(unmappedZones, a.ns_zone);
    }
    for (const p of provs) tally(anyProvider, p);
  }
  const nameOf = (id) => { const e = runCtx.dataset.entries.find(x => x.provider_id === id); return e ? e.provider_name : id; };

  // ── Report ────────────────────────────────────────────────────────────
  console.log(`\n## 1. COLLECTION OUTCOMES (${elapsed}s)`);
  console.log(`  firms processed:      ${rows.length}`);
  console.log(`  resolved (NS present):${resolved.length} (${pct(resolved.length, rows.length)})`);
  console.log(`  unresolved/failed:    ${failed} (${pct(failed, rows.length)})`);
  console.log(`  collection_status:`); for (const [k, v] of sortDesc(status)) console.log(`     ${k.padEnd(28)} ${v}`);

  console.log(`\n## 2. OPERATIONAL VALIDATION`);
  console.log(`  schema compliance:    ${resolved.length - schemaFail}/${resolved.length}  ${schemaFail === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  boundary violations:  ${boundaryViol}  ${boundaryViol === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  reproducibility(n=${sample.length}):  ${sample.length - reproFail}/${sample.length}  ${reproFail === 0 ? 'PASS' : 'FAIL'}`);

  console.log(`\n## 3. PROVISION MODEL DISTRIBUTION (of ${resolved.length} resolved)`);
  for (const [k, v] of sortDesc(model)) console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${pct(v, resolved.length)}`);
  console.log(`  -- self-operated:     ${selfOperated} (${pct(selfOperated, resolved.length)})`);
  console.log(`  -- third-party managed:${managed} (${pct(managed, resolved.length)})`);
  console.log(`  -- multi-provider:    ${multiProvider} (${pct(multiProvider, resolved.length)})`);
  console.log(`  -- undetermined(unmapped):${undetermined} (${pct(undetermined, resolved.length)})`);

  console.log(`\n## 3b. ZONE-LEVEL match_status`);
  for (const [k, v] of sortDesc(statusZone)) console.log(`  ${k.padEnd(22)} ${v}`);

  console.log(`\n## 4. PROVIDER PREVALENCE — primary (single-operator domains)`);
  for (const [id, v] of sortDesc(primaryProvider)) console.log(`  ${nameOf(id).padEnd(28)} ${String(v).padStart(5)}  ${pct(v, resolved.length)}`);
  console.log(`\n## 4b. PROVIDER PREVALENCE — appears anywhere (incl. multi/mixed)`);
  for (const [p, v] of sortDesc(anyProvider).slice(0, 12)) console.log(`  ${p.padEnd(34)} ${String(v).padStart(5)}  ${pct(v, resolved.length)}`);

  // concentration: top-3 mapped providers (by 'appears anywhere') share of resolved
  const top = sortDesc(anyProvider).slice(0, 3).reduce((a, [, v]) => a + v, 0);
  console.log(`\n## 4c. CONCENTRATION (Assessment-layer, descriptive)`);
  console.log(`  top-3 providers appear in ~${pct(top, resolved.length)} of resolved domains (note: domains may use >1 provider)`);
  const mappedAny = resolved.filter(r => r.attributions.some(a => a.match_status === 'MAPPED')).length;
  console.log(`  domains using >=1 known managed provider: ${mappedAny} (${pct(mappedAny, resolved.length)})`);

  console.log(`\n## 5. DATASET IMPROVEMENT — top unmapped NS-zones (DPR-DATA-002 candidates)`);
  for (const [z, v] of sortDesc(unmappedZones).slice(0, 20)) console.log(`  ${z.padEnd(34)} ${String(v).padStart(4)} domains`);
  console.log(`  (distinct unmapped zones: ${unmappedZones.size})`);

  console.log(`\n# rows preserved -> ${path.basename(OUT_ROWS)} (${resolved.length} resolved evidence rows)`);
})();
