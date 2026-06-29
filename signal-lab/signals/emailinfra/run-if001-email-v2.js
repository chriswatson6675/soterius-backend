'use strict';
// RUN-EMAILINFRA-002 — IF-001 re-attribution under EPR-DATA-002 (FROZEN v2.0).
// RE-ATTRIBUTION WITHOUT RECOLLECTION: preserved RUN-EMAILINFRA-001 Layer-A evidence re-attributed
// against frozen v2. NO new collection / DNS / FCA re-run. Evidence not modified. PSL unchanged.
const fs = require('fs');
const path = require('path');
const { makeAttributor, attributeObservation } = require('./emailinfra-signal');
const { validateRow } = require('./validate-email');
const { PSL_VERSION } = require('../dnsprovision/psl-processor');

const EVID = path.join(__dirname, 'if001-emailinfra-results.json');
const V1 = path.join(__dirname, '..', '..', 'data', 'email-provider-reference', 'v1.json');
const V2 = path.join(__dirname, '..', '..', 'data', 'email-provider-reference', 'v2.json');
const OUT = path.join(__dirname, 'if001-emailinfra-results-v2.json');
const load = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const pc = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '0%';
const tally = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const sortDesc = m => [...m.entries()].sort((a, b) => b[1] - a[1]);

function attributeAll(datasetFile, preserved) {
  const A = makeAttributor(load(datasetFile));
  const nameOf = id => { const e = A.ds.entries.find(x => x.provider_id === id); return e ? e.provider_name : id; };
  const classOf = id => { const e = A.ds.entries.find(x => x.provider_id === id); return e ? e.provider_class : null; };
  const rows = preserved.filter(r => r.has_mx).map(r =>
    attributeObservation(r.subject_domain, { has_mx: true, status: 'OK', mx_hosts: r.mx_hosts, raw: [] }, A));
  return { A, rows, nameOf, classOf };
}

function stats(rows, nameOf, classOf) {
  const model = new Map(), anyProvider = new Map(), mailboxAny = new Map(), gatewayAny = new Map(), unmapped = new Map();
  let self = 0, managed = 0, undet = 0, mixed = 0, multi = 0, hasGw = 0, m365 = 0, google = 0;
  for (const r of rows) {
    tally(model, r.email_provision_model);
    if (r.email_provision_model === 'SELF_HOSTED') self++;
    if (r.email_provision_model === 'THIRD_PARTY_SINGLE' || r.email_provision_model === 'THIRD_PARTY_MULTI') managed++;
    if (r.email_provision_model === 'UNDETERMINED') undet++;
    if (r.email_provision_model === 'MIXED') mixed++;
    if (r.multi_provider) multi++;
    if (r.has_gateway) hasGw++;
    const provs = new Set();
    for (const a of r.attributions) {
      if (a.match_status === 'MAPPED') provs.add(a.provider_id);
      if (a.match_status === 'UNMAPPED' && a.mx_etld1) tally(unmapped, a.mx_etld1);
    }
    for (const id of provs) {
      tally(anyProvider, id);
      if (classOf(id) === 'gateway') tally(gatewayAny, id); else tally(mailboxAny, id);
      if (id === 'EMXP-001') m365++;
      if (id === 'EMXP-002') google++;
    }
  }
  const N = rows.length;
  const mappedAny = rows.filter(r => r.attributions.some(a => a.match_status === 'MAPPED')).length;
  return { N, model, anyProvider, mailboxAny, gatewayAny, unmapped, self, managed, undet, mixed, multi, hasGw, m365, google, mappedAny };
}

const preserved = load(EVID);
const v1 = attributeAll(V1, preserved);
const v2 = attributeAll(V2, preserved);
const s1 = stats(v1.rows, v1.nameOf, v1.classOf);
const s2 = stats(v2.rows, v2.nameOf, v2.classOf);

// validation of the v2 re-attributed rows
let schemaFail = 0, boundary = 0, backend = 0;
for (const r of v2.rows) { const v = validateRow(r); if (v.errors.some(e => !e.includes('FORBIDDEN'))) schemaFail++; boundary += v.errors.filter(e => e.includes('FORBIDDEN')).length; if (JSON.stringify(r).toLowerCase().includes('backend')) backend++; }
fs.writeFileSync(OUT, JSON.stringify(v2.rows, null, 1));

console.log(`# RUN-EMAILINFRA-002 — IF-001 re-attribution (preserved evidence; NO re-run)`);
console.log(`# dataset=EPR-DATA-002/v2 (FROZEN) | psl=${PSL_VERSION} | mail-bearing=${s2.N}\n`);

console.log(`## D1 — RE-ATTRIBUTION (v1 -> v2)`);
const row = (label, a, b) => console.log(`  ${label.padEnd(26)} ${String(a).padStart(7)}  ${String(b).padStart(7)}   ${b !== a ? (b > a ? '+' : '') + (b - a) : '='}`);
console.log(`  ${'metric'.padEnd(26)} ${'RUN-001'.padStart(7)}  ${'RUN-002'.padStart(7)}   delta`);
row('UNDETERMINED', pc(s1.undet, s1.N), pc(s2.undet, s2.N));
row('MIXED', s1.mixed, s2.mixed);
row('managed (any 3rd-party)', pc(s1.managed, s1.N), pc(s2.managed, s2.N));
row('self-hosted', pc(s1.self, s1.N), pc(s2.self, s2.N));
row('gateway prevalence', pc(s1.hasGw, s1.N), pc(s2.hasGw, s2.N));
row('multi-provider', pc(s1.multi, s1.N), pc(s2.multi, s2.N));
console.log(`  (raw managed firms ${s1.managed} -> ${s2.managed}; UNDET firms ${s1.undet} -> ${s2.undet})`);

console.log(`\n## D2 — PROVISION MODEL (v2, of ${s2.N})`);
for (const [k, v] of sortDesc(s2.model)) console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)} ${pc(v, s2.N)}`);

console.log(`\n## D2 — PROVIDER RANKING (appears anywhere)  [v1 share -> v2 share]`);
for (const [id, v] of sortDesc(s2.anyProvider)) {
  const was = s1.anyProvider.get(id) || 0;
  console.log(`  ${(v2.nameOf(id) + ' [' + v2.classOf(id) + ']').padEnd(40)} ${String(v).padStart(5)} ${pc(v, s2.N).padStart(6)}  (was ${pc(was, s1.N)})`);
}
console.log(`  -- Microsoft 365 lower-bound: ${pc(s1.m365, s1.N)} -> ${pc(s2.m365, s2.N)}`);
console.log(`  -- Google Workspace:          ${pc(s1.google, s1.N)} -> ${pc(s2.google, s2.N)}`);
console.log(`  -- any gateway (has_gateway): ${pc(s1.hasGw, s1.N)} -> ${pc(s2.hasGw, s2.N)}`);

console.log(`\n## D2 — NEWLY VISIBLE providers (v2 entries EMXP-011..016 + additive)`);
for (const id of ['EMXP-011', 'EMXP-012', 'EMXP-013', 'EMXP-014', 'EMXP-015', 'EMXP-016']) {
  const v = s2.anyProvider.get(id) || 0; console.log(`  ${v2.nameOf(id).padEnd(40)} ${String(v).padStart(4)} ${pc(v, s2.N)}`);
}

console.log(`\n## D3 — DATASET EFFECTIVENESS`);
console.log(`  firms newly attributed (UNDET v1 -> attributed v2): ${s1.undet - s2.undet}`);
console.log(`  MIXED resolved to clean: ${s1.mixed - s2.mixed}`);
console.log(`  remaining UNDETERMINED: ${s2.undet} (${pc(s2.undet, s2.N)})`);
console.log(`  remaining distinct unmapped MX zones: ${s2.unmapped.size}`);
console.log(`  top remaining unmapped (EPR-DATA-003 candidates):`);
for (const [z, v] of sortDesc(s2.unmapped).slice(0, 12)) console.log(`     ${z.padEnd(30)} ${v}`);

console.log(`\n## VALIDATION`);
console.log(`  schema: ${s2.N - schemaFail}/${s2.N} ${schemaFail === 0 ? 'PASS' : 'FAIL'} | boundary violations: ${boundary} ${boundary === 0 ? 'PASS' : 'FAIL'} | backend refs: ${backend} ${backend === 0 ? 'PASS' : 'FAIL'}`);
console.log(`  preserved evidence rows: ${preserved.length} (unmodified) | v2 re-attributed rows -> ${path.basename(OUT)}`);
