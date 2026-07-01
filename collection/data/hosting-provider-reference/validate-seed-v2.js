'use strict';
// HPR-DATA-002 v2.0 — population VALIDATION (no re-attribution run; synthetic IPs only).
// Schema · identifier/ASN uniqueness · range integrity · provenance · version integrity ·
// STRICT-SUPERSET (HCP-001..003 byte-identical) · backward-compat · attribution re-checks.
const fs = require('fs');
const path = require('path');
const V1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'v1.json'), 'utf8'));
const V2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'v2.json'), 'utf8'));

const ipToInt = ip => ip.split('.').reduce((a, o) => (a << 8 >>> 0) + (+o), 0) >>> 0;
function pc(c) { const [ip, b] = c.split('/'); const l = +b; const m = l === 0 ? 0 : (0xFFFFFFFF << (32 - l)) >>> 0; return { net: (ipToInt(ip) & m) >>> 0, l, m }; }
const inC = (i, c) => ((i & c.m) >>> 0) === c.net;
const CLASSES = new Set(['hyperscale_cloud', 'managed_hosting', 'colocation', 'transit_isp', 'cdn_edge', 'other']);

const fails = [];
const chk = (name, ok) => { if (!ok) fails.push(name); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); };

const active = V2.entries.filter(e => e.status === 'ACTIVE');
console.log('# HPR-DATA-002 v2.0 — POPULATION VALIDATION\n');
console.log(`entries: ${V2.entries.length} (v1 had ${V1.entries.length}) | new: ${V2.entries.filter(e => e.version_added === 2).length}\n`);

console.log('## D3 — schema / uniqueness / integrity');
// schema
let schemaOk = true;
for (const e of active) { for (const f of ['provider_id', 'provider_name', 'provider_class', 'asns', 'ip_ranges', 'evidence_class', 'evidence_source', 'version_added', 'status']) if (!(f in e)) schemaOk = false; if (!CLASSES.has(e.provider_class)) schemaOk = false; if (!(e.asns.length || e.ip_ranges.length)) schemaOk = false; }
chk('schema complete; provider_class valid; >=1 key/entry', schemaOk);
// id unique
const ids = active.map(e => e.provider_id); chk('provider_id unique', new Set(ids).size === ids.length);
// ASN unique across providers
const asnMap = new Map(); let asnDup = false;
for (const e of active) for (const a of e.asns) { if (asnMap.has(a) && asnMap.get(a) !== e.provider_id) asnDup = true; asnMap.set(a, e.provider_id); }
chk('ASN keys unique across providers', !asnDup);
// valid CIDRs
let cidrOk = true; for (const e of active) for (const r of e.ip_ranges) if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(r.cidr)) cidrOk = false;
chk('ip_ranges valid IPv4 CIDRs', cidrOk);
// no cross-provider range overlap
const ranges = []; for (const e of active) for (const r of e.ip_ranges) ranges.push({ p: e.provider_id, c: pc(r.cidr) });
let overlap = false;
for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) { if (ranges[i].p === ranges[j].p) continue; const a = ranges[i].c, b = ranges[j].c; if (((a.net & b.m) >>> 0) === b.net || ((b.net & a.m) >>> 0) === a.net) overlap = true; }
chk('no cross-provider range overlap', !overlap);
// provenance + version
let prov = true; for (const e of active) { if (!e.evidence_class.length || !e.evidence_source) prov = false; for (const r of e.ip_ranges) if (!r.evidence_source || !r.snapshot_date) prov = false; if (![1, 2].includes(e.version_added)) prov = false; }
chk('provenance complete; version_added in {1,2}', prov);
chk('dataset_version = 2; governed_by HPR-001', V2.dataset_version === 2 && /HPR-001/.test(V2.governed_by));
// no prohibited fields
const FORB = /(score|rank|reputation|resilience|concentration|diversity|quality|risk|threat|market.?share|\bgeo|country|region|city|latitude|longitude)/i;
let clean = true; const scan = o => { if (o && typeof o === 'object') for (const k of Object.keys(o)) { if (FORB.test(k)) clean = false; scan(o[k]); } };
scan(V2.entries); chk('no prohibited (scoring/ranking/reputation/geo) fields', clean);

console.log('\n## D4 — strict superset / backward compatibility');
// HCP-001..003 byte-identical
let identical = true;
for (const id of ['HCP-001', 'HCP-002', 'HCP-003']) { const a = V1.entries.find(e => e.provider_id === id), b = V2.entries.find(e => e.provider_id === id); if (JSON.stringify(a) !== JSON.stringify(b)) identical = false; }
chk('HCP-001..003 byte-identical to v1', identical);
// every v1 ASN/range present, same provider; no v1 mapping changed
const v2asn = new Map(); for (const e of active) for (const a of e.asns) v2asn.set(a, e.provider_id);
let superset = true; for (const e of V1.entries) for (const a of e.asns) if (v2asn.get(a) !== e.provider_id) superset = false;
chk('strict superset: every v1 ASN maps to same provider in v2', superset);

console.log('\n## D3 — attribution re-checks (synthetic IPs; new providers)');
// build matcher
const asnIdx = new Map(); const rng = [];
for (const e of active) { for (const a of e.asns) asnIdx.set(a, e.provider_name); for (const r of e.ip_ranges) { const c = pc(r.cidr); rng.push({ p: e.provider_name, c, l: c.l }); } }
function attr(ip, asn) { const i = ipToInt(ip); let h = null; for (const r of rng) if (inC(i, r.c)) { if (!h || r.l > h.l) h = r; } const rp = h ? h.p : null; const ap = asnIdx.has(asn) ? asnIdx.get(asn) : null; if (rp && ap) return rp === ap ? { s: 'MAPPED', p: rp } : { s: 'CONFLICT' }; if (rp) return { s: 'MAPPED', p: rp }; if (ap) return { s: 'MAPPED', p: ap }; return { s: 'UNMAPPED' }; }
const cases = [
  ['104.16.5.5', null, 'MAPPED', 'Cloudflare'],     // Cloudflare range
  ['1.2.3.4', 13335, 'MAPPED', 'Cloudflare'],        // Cloudflare ASN
  ['146.75.10.1', null, 'MAPPED', 'Fastly'],         // Fastly range
  ['1.2.3.4', 20940, 'MAPPED', 'Akamai'],            // Akamai ASN
  ['157.245.85.1', null, 'MAPPED', 'DigitalOcean'],  // DO range
  ['1.2.3.4', 53831, 'MAPPED', 'Squarespace'],       // Squarespace ASN
  ['1.2.3.4', 26496, 'MAPPED', 'GoDaddy'],           // GoDaddy 2nd ASN
  ['54.79.1.2', null, 'MAPPED', 'Amazon Web Services'], // v1 AWS range still works
  ['8.8.8.8', 99999, 'UNMAPPED', null],              // unknown
];
for (const [ip, asn, es, ep] of cases) { const r = attr(ip, asn); const ok = r.s === es && (r.p || null) === ep; chk(`${ip}${asn ? '/AS' + asn : ''} -> ${r.s}${r.p ? ' ' + r.p : ''}`, ok); }

console.log('\n## SUMMARY');
console.log(`  providers: ${active.length} | ASN keys: ${asnIdx.size} | range keys: ${rng.length} | failures: ${fails.length}`);
if (fails.length) { fails.forEach(f => console.log('  FAIL', f)); process.exitCode = 1; }
else console.log('  ALL CHECKS PASS — v2 strict-superset populated and valid.');
