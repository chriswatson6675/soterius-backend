'use strict';
// RUN-CLOUDHOST-002 — IF-001 re-attribution under HPR-DATA-002 (FROZEN v2.0).
// RE-ATTRIBUTION WITHOUT RECOLLECTION: preserved RUN-CLOUDHOST-001 Layer-A evidence (resolved IPs +
// AS numbers) re-decoded against frozen v2.0. NO DNS/IP/ASN collection, NO new evidence. Evidence
// not modified. Assessment-layer stats are descriptive only — NO scoring.
const fs = require('fs');
const path = require('path');
const { makeAttributor, attributeObservation } = require('./cloudhost-signal');
const { validateRow, reproducible } = require('./validate-cloudhost');

const EVID = path.join(__dirname, 'if001-cloudhost-results.json');          // preserved RUN-001 evidence
const V1 = path.join(__dirname, '..', '..', 'data', 'hosting-provider-reference', 'v1.json');
const V2 = path.join(__dirname, '..', '..', 'data', 'hosting-provider-reference', 'v2.json');
const OUT = path.join(__dirname, 'if001-cloudhost-results-v2.json');
const load = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const pc = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '0%';
const tally = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const sortDesc = m => [...m.entries()].sort((a, b) => b[1] - a[1]);

// rebuild a Layer-A observation from a preserved row (resolved_ips carry ip/version/asn/bgp_prefix)
function obsOf(r) {
  return { has_endpoint: !!r.has_endpoint, status: r.collection_status,
    resolved_ips: (r.resolved_ips || []).map(x => ({ ip: x.ip, version: x.version, asn: x.asn, bgp_prefix: x.bgp_prefix, cc: null, rir: null })) };
}
function attributeAll(datasetFile, preserved) {
  const A = makeAttributor(load(datasetFile));
  const rows = preserved.map(r => attributeObservation(r.subject_domain, obsOf(r), A, r.collection_timestamp));
  const nameOf = id => { const e = A.ds.entries.find(x => x.provider_id === id); return e ? e.provider_name : id; };
  const classOf = id => { const e = A.ds.entries.find(x => x.provider_id === id); return e ? e.provider_class : null; };
  return { A, rows, nameOf, classOf };
}
function stats(rows) {
  const withEp = rows.filter(r => r.has_endpoint);
  const model = new Map(), anyProvider = new Map(); let mappedAny = 0, multi = 0;
  for (const r of withEp) {
    tally(model, r.hosting_provision_model);
    if (r.multi_provider) multi++;
    const provs = new Set(); let hasMapped = false;
    for (const a of r.ip_attributions) if (a.match_status === 'MAPPED') { provs.add(a.provider_id); hasMapped = true; }
    if (hasMapped) mappedAny++;
    for (const p of provs) tally(anyProvider, p);
  }
  return { N: withEp.length, model, anyProvider, mappedAny, multi };
}

const preserved = load(EVID);
const v1 = attributeAll(V1, preserved);
const v2 = attributeAll(V2, preserved);
const s1 = stats(v1.rows), s2 = stats(v2.rows);

// validation of v2 re-attributed rows
let schemaFail = 0, boundary = 0, reproFail = 0;
for (const r of v2.rows) { const v = validateRow(r); if (v.errors.some(e => !e.includes('FORBIDDEN') && !e.includes('geolocation') && !e.includes('confidence'))) schemaFail++; boundary += v.errors.filter(e => e.includes('FORBIDDEN') || e.includes('geolocation') || e.includes('confidence')).length; }
// reproducibility: re-attribute identical evidence twice
for (const r of v2.rows.filter(r => r.has_endpoint).slice(0, 30)) { const o = obsOf(r); const a = attributeObservation(r.subject_domain, o, v2.A), b = attributeObservation(r.subject_domain, o, v2.A); if (!reproducible(a, b)) reproFail++; }
// evidence-unmodified check: Layer-A resolved_ips identical between preserved and v2 row
let evidenceChanged = 0;
for (let i = 0; i < preserved.length; i++) { const a = JSON.stringify((preserved[i].resolved_ips || []).map(x => [x.ip, x.asn])); const b = JSON.stringify((v2.rows[i].resolved_ips || []).map(x => [x.ip, x.asn])); if (a !== b) evidenceChanged++; }
fs.writeFileSync(OUT, JSON.stringify(v2.rows, null, 1));

console.log('# RUN-CLOUDHOST-002 — IF-001 re-attribution (preserved evidence; NO collection)');
console.log(`# dataset=${v2.A.datasetVersion} (frozen=${v2.A.frozen}) | preserved rows=${preserved.length} | resolved=${s2.N}\n`);

console.log('## D2 — VALIDATION');
console.log(`  schema: ${v2.rows.length - schemaFail}/${v2.rows.length} ${schemaFail === 0 ? 'PASS' : 'FAIL'} | boundary: ${boundary} ${boundary === 0 ? 'PASS' : 'FAIL'} | reproducibility(n=30): ${30 - reproFail}/30 ${reproFail === 0 ? 'PASS' : 'FAIL'}`);
console.log(`  Layer-A evidence unmodified: ${evidenceChanged === 0 ? 'PASS' : 'FAIL (' + evidenceChanged + ' changed)'} | version-stamped v2: ${v2.rows.every(r => /v2/.test(r.hpr_dataset_version)) ? 'PASS' : 'FAIL'}`);

console.log('\n## D3 — COVERAGE COMPARISON (v1.0 -> v2.0)');
const row = (l, a, b) => console.log(`  ${l.padEnd(26)} ${String(a).padStart(8)}  ${String(b).padStart(8)}`);
row('metric', 'RUN-001', 'RUN-002');
row('operator-attributed', pc(s1.mappedAny, s1.N), pc(s2.mappedAny, s2.N));
row('UNDETERMINED', pc((s1.model.get('UNDETERMINED') || 0), s1.N), pc((s2.model.get('UNDETERMINED') || 0), s2.N));
row('SINGLE_PROVIDER', pc((s1.model.get('SINGLE_PROVIDER') || 0), s1.N), pc((s2.model.get('SINGLE_PROVIDER') || 0), s2.N));
row('MIXED', (s1.model.get('MIXED') || 0), (s2.model.get('MIXED') || 0));
row('MULTI_PROVIDER', (s1.model.get('MULTI_PROVIDER') || 0), (s2.model.get('MULTI_PROVIDER') || 0));
console.log(`  attribution lift: +${s2.mappedAny - s1.mappedAny} firms (${pc(s1.mappedAny, s1.N)} -> ${pc(s2.mappedAny, s2.N)})`);

console.log('\n## D4 — INFRASTRUCTURE DISTRIBUTION (v2.0; appears-anywhere)');
const byClass = { hyperscale_cloud: [], cdn_edge: [], managed_hosting: [] };
for (const [id, v] of sortDesc(s2.anyProvider)) { const c = v2.classOf(id); (byClass[c] || (byClass[c] = [])).push([v2.nameOf(id), v]); }
let cdnFirms = 0, hyperFirms = 0, mhFirms = 0;
for (const r of v2.rows.filter(r => r.has_endpoint)) {
  const classes = new Set(r.ip_attributions.filter(a => a.match_status === 'MAPPED').map(a => a.provider_class));
  if (classes.has('cdn_edge')) cdnFirms++; if (classes.has('hyperscale_cloud')) hyperFirms++; if (classes.has('managed_hosting')) mhFirms++;
}
for (const cls of ['hyperscale_cloud', 'cdn_edge', 'managed_hosting']) {
  console.log(`  [${cls}] ` + byClass[cls].map(([n, v]) => `${n} ${pc(v, s2.N)}`).join(' · '));
}
console.log(`  firms with >=1 hyperscale: ${hyperFirms} (${pc(hyperFirms, s2.N)}) | cdn_edge: ${cdnFirms} (${pc(cdnFirms, s2.N)}) | managed_hosting: ${mhFirms} (${pc(mhFirms, s2.N)})`);

console.log(`\n# rows preserved -> ${path.basename(OUT)} (${v2.rows.length} rows; original Layer-A + provenance retained)`);
