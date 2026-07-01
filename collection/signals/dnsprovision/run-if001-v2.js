'use strict';
// RUN-DNSPROVISION-002 — IF-001 re-attribution under DPR-DATA-002 (v2). NO new collection.
// Re-attributes the PRESERVED RUN-001 evidence against v1 and v2 (apples-to-apples) and compares.
const fs = require('fs');
const path = require('path');
const { loadDataset, buildIndex, attributeZone, deriveComposition } = require('./dpr-attribution');

const DATADIR = path.join(__dirname, '..', '..', 'data', 'dns-provider-reference');
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'if001-dnsprovision-results.json'), 'utf8')).filter(r => (r.ns_hostnames || []).length > 0);
const v1 = loadDataset(path.join(DATADIR, 'v1.json')), v2 = loadDataset(path.join(DATADIR, 'v2.json'));

function stats(ds) {
  const idx = buildIndex(ds);
  const nameOf = (id) => { const e = ds.entries.find(x => x.provider_id === id); return e ? e.provider_name : id; };
  const model = new Map(), primary = new Map();
  let self = 0, multi = 0, managed = 0, undet = 0;
  for (const r of rows) {
    const attrs = r.ns_zones.map(z => attributeZone(z, r.subject_etld1, idx.index, idx.duplicates));
    const c = r.ns_zones.length ? deriveComposition(attrs) : { dns_provision_model: 'UNDETERMINED', primary_dns_provider_id: null };
    model.set(c.dns_provision_model, (model.get(c.dns_provision_model) || 0) + 1);
    if (c.dns_provision_model === 'SELF_OPERATED') self++;
    if (c.dns_provision_model === 'THIRD_PARTY_SINGLE' || c.dns_provision_model === 'THIRD_PARTY_MULTI') managed++;
    if (c.dns_provision_model === 'UNDETERMINED') undet++;
    if (attrs.filter(a => a.match_status === 'MAPPED').map(a => a.provider_id).filter((v, i, s) => s.indexOf(v) === i).length > 1 || (c.dns_provision_model === 'THIRD_PARTY_MULTI')) multi++;
    if (c.primary_dns_provider_id) primary.set(c.primary_dns_provider_id, (primary.get(c.primary_dns_provider_id) || 0) + 1);
  }
  return { model, primary, self, multi, managed, undet, nameOf };
}

const N = rows.length, pct = (n) => (100 * n / N).toFixed(1) + '%';
const A = stats(v1), B = stats(v2);

console.log(`# RUN-DNSPROVISION-002 — IF-001 RE-ATTRIBUTION (v1 -> v2)`);
console.log(`# preserved evidence: ${N} resolved firms | NO new collection | psl=${require('./psl-processor').PSL_VERSION}`);
console.log(`# v1=DPR-DATA-001 (FROZEN) | v2=DPR-DATA-002 (Freeze Candidate, ${v2.entries.length} entries)\n`);

console.log('## COVERAGE');
console.log(`  mapped:        v1 ${N - A.undet} (${pct(N - A.undet)})  ->  v2 ${N - B.undet} (${pct(N - B.undet)})   (+${(N - B.undet) - (N - A.undet)})`);
console.log(`  UNDETERMINED:  v1 ${A.undet} (${pct(A.undet)})  ->  v2 ${B.undet} (${pct(B.undet)})`);

console.log('\n## PROVISION MODEL (v1 -> v2)');
const models = [...new Set([...A.model.keys(), ...B.model.keys()])];
for (const m of models) console.log(`  ${m.padEnd(20)} ${String(A.model.get(m) || 0).padStart(5)} (${pct(A.model.get(m) || 0)})  ->  ${String(B.model.get(m) || 0).padStart(5)} (${pct(B.model.get(m) || 0)})`);
console.log(`  -- self-operated:      ${A.self} -> ${B.self}  (${pct(A.self)} -> ${pct(B.self)})`);
console.log(`  -- third-party managed:${A.managed} -> ${B.managed}  (${pct(A.managed)} -> ${pct(B.managed)})`);
console.log(`  -- multi-provider:     ${A.multi} -> ${B.multi}  (${pct(A.multi)} -> ${pct(B.multi)})`);

console.log('\n## PROVIDER PREVALENCE — primary (single-operator)  v1 -> v2');
const provs = [...new Set([...A.primary.keys(), ...B.primary.keys()])].sort((x, y) => (B.primary.get(y) || 0) - (B.primary.get(x) || 0));
for (const id of provs) {
  const a = A.primary.get(id) || 0, b = B.primary.get(id) || 0;
  const tag = (a === 0 && b > 0) ? '  <-- newly visible (v2)' : '';
  console.log(`  ${B.nameOf(id).padEnd(24)} ${String(a).padStart(4)} (${pct(a)})  ->  ${String(b).padStart(4)} (${pct(b)})${tag}`);
}
