'use strict';
// HPR-DATA-003 v3.0 — population VALIDATION + coverage estimate (no re-attribution run).
// Strict-superset vs v2 (HCP-001..011,013..016 byte-identical; HCP-012 additive-only).
const fs = require('fs');
const path = require('path');
const V2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'v2.json'), 'utf8'));
const V3 = JSON.parse(fs.readFileSync(path.join(__dirname, 'v3.json'), 'utf8'));
const CLASSES = new Set(['hyperscale_cloud', 'managed_hosting', 'colocation', 'transit_isp', 'cdn_edge', 'other']);
const fails = []; const chk = (n, ok) => { if (!ok) fails.push(n); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${n}`); };
const active = V3.entries.filter(e => e.status === 'ACTIVE');

console.log('# HPR-DATA-003 v3.0 — POPULATION VALIDATION\n');
console.log(`entries: ${V3.entries.length} (v2 had ${V2.entries.length}) | new(v3): ${V3.entries.filter(e => e.version_added === 3).length}\n`);

console.log('## D3 — schema / uniqueness');
let schemaOk = true; for (const e of active) { for (const f of ['provider_id', 'provider_name', 'provider_class', 'asns', 'ip_ranges', 'evidence_class', 'evidence_source', 'version_added', 'status']) if (!(f in e)) schemaOk = false; if (!CLASSES.has(e.provider_class)) schemaOk = false; if (!(e.asns.length || e.ip_ranges.length)) schemaOk = false; }
chk('schema complete; provider_class valid; >=1 key', schemaOk);
const ids = active.map(e => e.provider_id); chk('provider_id unique', new Set(ids).size === ids.length);
const asnMap = new Map(); let dup = false; for (const e of active) for (const a of e.asns) { if (asnMap.has(a) && asnMap.get(a) !== e.provider_id) dup = true; asnMap.set(a, e.provider_id); }
chk('ASN keys unique across providers', !dup);
chk('version_added in {1,2,3}', active.every(e => [1, 2, 3].includes(e.version_added)));
chk('dataset_version = 3', V3.dataset_version === 3);
const FORB = /(score|rank|reputation|resilience|concentration|quality|risk|threat|market.?share|\bgeo|country|region|city)/i;
let clean = true; const scan = o => { if (o && typeof o === 'object') for (const k of Object.keys(o)) { if (FORB.test(k)) clean = false; scan(o[k]); } }; scan(V3.entries);
chk('no prohibited fields', clean);

console.log('\n## D5 — strict superset / backward compatibility vs v2');
// HCP-001..011,013..016 byte-identical; HCP-012 additive-only
let identical = true, godaddyOk = false;
for (const e2 of V2.entries) {
  const e3 = V3.entries.find(x => x.provider_id === e2.provider_id);
  if (e2.provider_id === 'HCP-012') {
    const v2set = new Set(e2.asns), v3set = new Set(e3.asns);
    godaddyOk = [...v2set].every(a => v3set.has(a)) && e3.asns.length > e2.asns.length && e2.provider_name === e3.provider_name;
  } else if (JSON.stringify(e2) !== JSON.stringify(e3)) identical = false;
}
chk('HCP-001..011,013..016 byte-identical to v2', identical);
chk('HCP-012 additive-only (all v2 ASNs retained + new; name unchanged)', godaddyOk);
const v3asn = new Map(); for (const e of active) for (const a of e.asns) v3asn.set(a, e.provider_id);
let superset = true; for (const e of V2.entries) for (const a of e.asns) if (v3asn.get(a) !== e.provider_id) superset = false;
chk('strict superset: every v2 ASN -> same provider in v3', superset);

console.log('\n## D3 — attribution re-checks (new providers; v2 still works)');
const asnIdx = new Map(); for (const e of active) for (const a of e.asns) asnIdx.set(a, e.provider_name);
const cases = [[63949, 'Linode'], [33070, 'Rackspace'], [20473, 'Vultr'], [31898, 'Oracle Cloud'], [48254, '20i'], [12488, 'Krystal'], [29222, 'Infomaniak'], [398101, 'GoDaddy'], [398787, 'GoDaddy'], [13335, 'Cloudflare'], [16509, 'Amazon Web Services'], [15169, undefined]];
for (const [asn, exp] of cases) { const got = asnIdx.get(asn); chk(`AS${asn} -> ${got || 'UNMAPPED'}`, got === exp || (exp === undefined && got === undefined)); }

console.log('\n## SUMMARY');
console.log(`  providers: ${active.length} | ASN keys: ${asnIdx.size} | failures: ${fails.length}`);

// ---- D4 coverage estimate from preserved RUN-CLOUDHOST-002 evidence (tally, NOT re-attribution) ----
console.log('\n## D4 — coverage estimate (preserved RUN-CLOUDHOST-002 evidence; tally, no re-attribution)');
const EV = path.join(__dirname, '..', '..', 'signals', 'cloudhost', 'if001-cloudhost-results-v2.json');
const rows = JSON.parse(fs.readFileSync(EV, 'utf8')).filter(r => r.has_endpoint);
const N = rows.length;
const v3asnSet = new Set(asnIdx.keys());
let undet = 0, undetNowAttr = 0;
for (const r of rows) {
  if (r.hosting_provision_model !== 'UNDETERMINED') continue; undet++;
  const hit = r.ip_attributions.some(a => a.match_status === 'UNMAPPED' && a.asn != null && v3asnSet.has(a.asn));
  if (hit) undetNowAttr++;
}
const pc = n => (100 * n / N).toFixed(1) + '%';
const baseAttr = N - undet;
console.log(`  baseline (v2): attributed ${pc(baseAttr)} | UNDETERMINED ${pc(undet)}`);
console.log(`  UNDETERMINED firms newly attributable via v3 head: ${undetNowAttr} (${pc(undetNowAttr)})`);
console.log(`  projected v3: attributed ${pc(baseAttr + undetNowAttr)} | UNDETERMINED ${pc(undet - undetNowAttr)}`);
if (fails.length) { fails.forEach(f => console.log('  FAIL', f)); process.exitCode = 1; } else console.log('\n  ALL VALIDATION CHECKS PASS.');
