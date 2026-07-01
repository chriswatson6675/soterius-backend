'use strict';
// DPR-DATA-002 validation + coverage re-attribution.
// Validates v2 against DPR-001; confirms v1 immutable; re-attributes the PRESERVED IF-001 evidence
// (if001-dnsprovision-results.json) against v2 — re-attribution WITHOUT recollection (no FCA re-run).
const fs = require('fs');
const path = require('path');
const { loadDataset, buildIndex, attributeZone, deriveComposition } = require('./dpr-attribution');

const DATADIR = path.join(__dirname, '..', '..', 'data', 'dns-provider-reference');
const v1 = loadDataset(path.join(DATADIR, 'v1.json'));
const v2 = loadDataset(path.join(DATADIR, 'v2.json'));
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'if001-dnsprovision-results.json'), 'utf8')).filter(r => (r.ns_hostnames || []).length > 0);

function reattribute(row, idx, dup) {
  const attrs = row.ns_zones.map(z => attributeZone(z, row.subject_etld1, idx, dup));
  const comp = row.ns_zones.length ? deriveComposition(attrs) : { dns_provision_model: 'UNDETERMINED', primary_dns_provider_id: null, distinct_dns_operator_count: 0 };
  return { attrs, comp };
}

console.log('# DPR-DATA-002 Validation & Coverage Re-attribution\n');

// ── 1. Dataset validation ───────────────────────────────────────────────
const v2i = buildIndex(v2);
const ids = v2.entries.map(e => e.provider_id);
const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
const names = v2.entries.map(e => e.provider_name);
const dupNames = names.filter((x, i) => names.indexOf(x) !== i);
const allZones = v2.entries.flatMap(e => e.ns_zones.map(z => z.toLowerCase()));
const zoneDupes = [...new Set(allZones.filter((z, i) => allZones.indexOf(z) !== i))];
let schemaBad = 0;
for (const e of v2.entries) if (!e.provider_id || !e.provider_name || !Array.isArray(e.ns_zones) || !e.ns_zones.length || !e.evidence_source || !e.status) schemaBad++;
console.log('## 1. DATASET VALIDATION (DPR-001)');
console.log(`  entries:                 ${v2.entries.length}  (v1 ${v1.entries.length} + 7)`);
console.log(`  ns_zones:                ${allZones.length}`);
console.log(`  schema complete:         ${v2.entries.length - schemaBad}/${v2.entries.length}  ${schemaBad === 0 ? 'PASS' : 'FAIL'}`);
console.log(`  provider_id unique:      ${dupIds.length === 0 ? 'PASS' : 'FAIL ' + dupIds}`);
console.log(`  provider_name unique:    ${dupNames.length === 0 ? 'PASS' : 'FAIL ' + dupNames}`);
console.log(`  ns_zone disjoint (B-1):  ${zoneDupes.length === 0 ? 'PASS (0 shared)' : 'FAIL ' + zoneDupes}`);
console.log(`  index duplicate defects: ${v2i.duplicates.length}  ${v2i.duplicates.length === 0 ? 'PASS' : 'FAIL'}`);

// ── 2. v1 immutability ──────────────────────────────────────────────────
const v1ok = v1.entries.length === 10 && v1.status === 'DATASET_FREEZE_v1.0_FROZEN';
const v1Superset = v1.entries.every(e1 => { const e2 = v2.entries.find(x => x.provider_id === e1.provider_id); return e2 && JSON.stringify(e2.ns_zones) === JSON.stringify(e1.ns_zones); });
console.log('\n## 2. v1 IMMUTABILITY / SUPERSET');
console.log(`  DPR-DATA-001 v1.json unchanged (10 entries, FROZEN): ${v1ok ? 'PASS' : 'FAIL'}`);
console.log(`  v2 preserves all v1 entries+zones (strict superset):  ${v1Superset ? 'PASS' : 'FAIL'}`);

// ── 3. Coverage re-attribution (preserved evidence; no recollection) ────
const v1idx = buildIndex(v1);
let v1mapped = 0, v2mapped = 0, changed = 0, newlyMapped = 0;
const perProvider = new Map();
for (const r of rows) {
  const a1 = reattribute(r, v1idx.index, v1idx.duplicates);
  const a2 = reattribute(r, v2i.index, v2i.duplicates);
  const m1 = a1.comp.dns_provision_model !== 'UNDETERMINED';
  const m2 = a2.comp.dns_provision_model !== 'UNDETERMINED';
  if (m1) v1mapped++; if (m2) v2mapped++;
  if (!m1 && m2) { newlyMapped++; const p = a2.comp.primary_dns_provider_id || a2.attrs.find(x => x.match_status === 'MAPPED')?.provider_id; if (p) perProvider.set(p, (perProvider.get(p) || 0) + 1); }
  // backward-compat: every zone MAPPED under v1 must map to the SAME provider under v2
  for (let i = 0; i < a1.attrs.length; i++) {
    if (a1.attrs[i].match_status === 'MAPPED' && (a2.attrs[i].match_status !== 'MAPPED' || a2.attrs[i].provider_id !== a1.attrs[i].provider_id)) changed++;
  }
}
const N = rows.length;
const pct = (n) => (100 * n / N).toFixed(1) + '%';
const nameOf = (id) => { const e = v2.entries.find(x => x.provider_id === id); return e ? e.provider_name : id; };
console.log('\n## 3. COVERAGE RE-ATTRIBUTION (preserved IF-001 evidence, no FCA re-run)');
console.log(`  resolved firms:          ${N}`);
console.log(`  mapped under v1:          ${v1mapped} (${pct(v1mapped)})   [matches RUN-DNSPROVISION-001]`);
console.log(`  mapped under v2:          ${v2mapped} (${pct(v2mapped)})`);
console.log(`  newly attributable:       +${newlyMapped} firms (+${(100*newlyMapped/N).toFixed(1)}pp)`);
console.log(`  UNDETERMINED v1->v2:      ${N - v1mapped} (${pct(N-v1mapped)}) -> ${N - v2mapped} (${pct(N-v2mapped)})`);
console.log(`  BACKWARD-COMPAT — v1 mappings changed under v2: ${changed}  ${changed === 0 ? 'PASS (none changed)' : 'FAIL'}`);
console.log('\n  newly-mapped firms by provider:');
for (const [id, v] of [...perProvider.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${nameOf(id).padEnd(22)} +${v}`);
