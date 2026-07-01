'use strict';
// RUN-EMAILINFRA-001 — first operational Email Infrastructure Identity cohort collection.
// Executes SOT-EMAILINFRA-001 across the full IF-001 population (frozen EPR-DATA-001 v1.0).
// Preserves Layer-A MX evidence; computes Assessment-layer population statistics (descriptive only —
// NO risk/resilience/trust scoring). Backend never inferred. MX-only (no SPF/DKIM/DMARC, no IP/ASN).
const fs = require('fs');
const path = require('path');
const { makeAttributor, runDomain } = require('./emailinfra-signal');
const { validateRow, reproducible } = require('./validate-email');
const { PSL_VERSION } = require('../dnsprovision/psl-processor');

const MANIFEST = path.join(__dirname, '..', '..', 'if001-full', 'cohort-manifest.json');
const OUT_ROWS = path.join(__dirname, 'if001-emailinfra-results.json');
const CONCURRENCY = 24;

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) break;
      out[idx] = await worker(items[idx], idx);
      if (idx % 100 === 0) process.stderr.write(`  ..${idx}/${items.length}\r`); }
  }));
  return out;
}
function tally(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function sortDesc(map) { return [...map.entries()].sort((a, b) => b[1] - a[1]); }
function pct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '0%'; }

(async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const firms = manifest.firms.filter(f => f.domain);
  const attributor = makeAttributor();          // frozen EPR-DATA-001 v1
  const nameOf = (id) => { const e = attributor.ds.entries.find(x => x.provider_id === id); return e ? e.provider_name : id; };
  const classOf = (id) => { const e = attributor.ds.entries.find(x => x.provider_id === id); return e ? e.provider_class : null; };

  console.log(`# RUN-EMAILINFRA-001 — IF-001 Email Infrastructure Identity cohort collection`);
  console.log(`# cohort=${manifest.cohort_id} firms=${firms.length} | dataset=${attributor.datasetVersion} (FROZEN) | psl=${PSL_VERSION}`);
  console.log(`# keys: ${attributor.idx.suffixList.length} DOCUMENTED_SUFFIX, ${attributor.idx.etld1Index.size} ETLD1 | duplicate defects=${attributor.idx.duplicates.size}\n`);

  const t0 = Date.now();
  const rows = await pool(firms, CONCURRENCY, async (f) => {
    try { return await runDomain(f.domain, attributor); }
    catch (e) { return { subject_domain: f.domain, collection_status: 'COLLECT_ERROR', error: e.code,
      has_mx: false, mx_hosts: [], attributions: [], email_provision_model: 'UNDETERMINED', distinct_email_operator_count: 0, has_gateway: false }; }
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(OUT_ROWS, JSON.stringify(rows, null, 1));

  // ── Collection outcomes ───────────────────────────────────────────────
  const status = new Map();
  for (const r of rows) tally(status, r.collection_status || 'OK');
  const withMx = rows.filter(r => r.has_mx);
  const noMx = rows.filter(r => r.collection_status === 'NO_MX').length;
  const unresolved = rows.filter(r => r.collection_status === 'MX_UNRESOLVED' || r.collection_status === 'COLLECT_ERROR').length;

  // ── Validation ────────────────────────────────────────────────────────
  let schemaFail = 0, boundaryViol = 0, backendRefs = 0;
  for (const r of rows) {
    const v = validateRow(r);
    if (v.errors.some(e => !e.includes('FORBIDDEN'))) schemaFail++;
    boundaryViol += v.errors.filter(e => e.includes('FORBIDDEN')).length;
    if (JSON.stringify(r).toLowerCase().includes('backend')) backendRefs++;
  }
  let reproFail = 0;
  const sample = withMx.slice(0, 30);
  for (const r of sample) { const r2 = await runDomain(r.subject_domain, attributor); if (!reproducible(r, r2)) reproFail++; }

  // ── Attribution / population distributions (Assessment-layer, descriptive) ──
  const model = new Map(), primaryProvider = new Map(), anyProvider = new Map(), statusTally = new Map();
  const mailboxAny = new Map(), gatewayAny = new Map(), unmappedZones = new Map();
  let selfHosted = 0, managed = 0, undetermined = 0, multi = 0, hasGatewayN = 0, m365Any = 0;
  for (const r of withMx) {
    tally(model, r.email_provision_model);
    if (r.email_provision_model === 'SELF_HOSTED') selfHosted++;
    if (r.email_provision_model === 'THIRD_PARTY_SINGLE' || r.email_provision_model === 'THIRD_PARTY_MULTI') managed++;
    if (r.email_provision_model === 'UNDETERMINED') undetermined++;
    if (r.multi_provider) multi++;
    if (r.has_gateway) hasGatewayN++;
    if (r.primary_email_provider_id) tally(primaryProvider, r.primary_email_provider_id);
    const provs = new Set();
    for (const a of r.attributions) {
      tally(statusTally, a.match_status);
      if (a.match_status === 'MAPPED') provs.add(a.provider_id);
      if (a.match_status === 'UNMAPPED' && a.mx_etld1) tally(unmappedZones, a.mx_etld1);
    }
    for (const id of provs) {
      tally(anyProvider, id);
      if (classOf(id) === 'gateway') tally(gatewayAny, id); else tally(mailboxAny, id);
      if (id === 'EMXP-001') m365Any++;
    }
  }

  // ── Report ────────────────────────────────────────────────────────────
  console.log(`## 1. COLLECTION OUTCOMES (${elapsed}s)`);
  console.log(`  firms processed:        ${rows.length}`);
  console.log(`  has MX (mail-bearing):  ${withMx.length} (${pct(withMx.length, rows.length)})`);
  console.log(`  NO_MX (no inbound mail):${noMx} (${pct(noMx, rows.length)})`);
  console.log(`  unresolved/error:       ${unresolved} (${pct(unresolved, rows.length)})`);
  console.log(`  collection_status:`); for (const [k, v] of sortDesc(status)) console.log(`     ${k.padEnd(18)} ${v}`);

  console.log(`\n## 2. OPERATIONAL VALIDATION`);
  console.log(`  schema compliance:    ${rows.length - schemaFail}/${rows.length}  ${schemaFail === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  boundary violations:  ${boundaryViol}  ${boundaryViol === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  backend references:   ${backendRefs}  ${backendRefs === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  reproducibility(n=${sample.length}): ${sample.length - reproFail}/${sample.length}  ${reproFail === 0 ? 'PASS' : 'FAIL'}`);

  console.log(`\n## 3. PROVISION MODEL DISTRIBUTION (of ${withMx.length} mail-bearing)`);
  for (const [k, v] of sortDesc(model)) console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${pct(v, withMx.length)}`);
  console.log(`  -- self-hosted:        ${selfHosted} (${pct(selfHosted, withMx.length)})`);
  console.log(`  -- third-party managed:${managed} (${pct(managed, withMx.length)})`);
  console.log(`  -- multi-provider:     ${multi} (${pct(multi, withMx.length)})`);
  console.log(`  -- undetermined(unmapped):${undetermined} (${pct(undetermined, withMx.length)})`);

  console.log(`\n## 3b. MX-host match_status`);
  for (const [k, v] of sortDesc(statusTally)) console.log(`  ${k.padEnd(24)} ${v}`);

  console.log(`\n## 4. PROVIDER PREVALENCE — appears anywhere (incl. multi/mixed)`);
  for (const [id, v] of sortDesc(anyProvider)) console.log(`  ${(nameOf(id) + ' [' + classOf(id) + ']').padEnd(34)} ${String(v).padStart(5)}  ${pct(v, withMx.length)}`);

  console.log(`\n## 4b. MAILBOX-PROVIDER prevalence`);
  for (const [id, v] of sortDesc(mailboxAny)) console.log(`  ${nameOf(id).padEnd(26)} ${String(v).padStart(5)}  ${pct(v, withMx.length)}`);
  console.log(`\n## 4c. GATEWAY prevalence (security/relay edge)`);
  for (const [id, v] of sortDesc(gatewayAny)) console.log(`  ${nameOf(id).padEnd(26)} ${String(v).padStart(5)}  ${pct(v, withMx.length)}`);
  console.log(`  -- any gateway present (has_gateway): ${hasGatewayN} (${pct(hasGatewayN, withMx.length)})`);

  console.log(`\n## 4d. CONCENTRATION (Assessment-layer, descriptive; EPR-001 §12.3 lower-bound)`);
  console.log(`  Microsoft 365 observed in AT LEAST ${pct(m365Any, withMx.length)} of mail-bearing domains`);
  console.log(`    (LOWER BOUND — gateway-fronted M365 is masked as the gateway; true share >= observed)`);
  const top3 = sortDesc(anyProvider).slice(0, 3);
  const top3sum = top3.reduce((a, [, v]) => a + v, 0);
  console.log(`  top-3 providers (${top3.map(([id]) => nameOf(id)).join(', ')}) appear in ~${pct(top3sum, withMx.length)} of mail-bearing domains`);
  const mappedAny = withMx.filter(r => r.attributions.some(a => a.match_status === 'MAPPED')).length;
  console.log(`  domains using >=1 known managed email provider: ${mappedAny} (${pct(mappedAny, withMx.length)})`);

  console.log(`\n## 5. DATASET IMPROVEMENT — top unmapped MX eTLD+1 (EPR-DATA-002 candidates)`);
  for (const [z, v] of sortDesc(unmappedZones).slice(0, 20)) console.log(`  ${z.padEnd(34)} ${String(v).padStart(4)} domains`);
  console.log(`  (distinct unmapped MX zones: ${unmappedZones.size})`);

  console.log(`\n# rows preserved -> ${path.basename(OUT_ROWS)} (${rows.length} evidence rows; ${withMx.length} mail-bearing)`);
})().catch(e => { console.error('FATAL', e); process.exitCode = 1; });
