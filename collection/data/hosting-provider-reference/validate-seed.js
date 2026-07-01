'use strict';
// HPR-DATA-001 v1.0 — seed dataset VALIDATION (no live/cohort attribution; synthetic test IPs only).
// Demonstrates the HPR-001 §7 attribution model against the populated v1.json:
//   IP_RANGE_CONTAINMENT (longest-prefix), ASN_EXACT, precedence (range>ASN),
//   CONFLICT (cross-key disagreement), UNMAPPED (no match) — plus governance/schema checks.
const fs = require('fs');
const path = require('path');
const DS = JSON.parse(fs.readFileSync(path.join(__dirname, 'v1.json'), 'utf8'));

// ---- IPv4 helpers (no deps) ----
const ipToInt = (ip) => ip.split('.').reduce((a, o) => (a << 8 >>> 0) + (+o), 0) >>> 0;
function parseCidr(c) { const [ip, bits] = c.split('/'); const len = +bits; const mask = len === 0 ? 0 : (0xFFFFFFFF << (32 - len)) >>> 0; return { net: (ipToInt(ip) & mask) >>> 0, len, mask }; }
const inCidr = (ipInt, c) => ((ipInt & c.mask) >>> 0) === c.net;

// ---- build index (ACTIVE only) ----
const active = DS.entries.filter(e => e.status === 'ACTIVE');
const asnIndex = new Map();   // asn -> provider_id
const ranges = [];            // {provider_id, cidrObj, len}
for (const e of active) {
  for (const a of (e.asns || [])) asnIndex.set(a, e.provider_id);
  for (const r of (e.ip_ranges || [])) ranges.push({ provider_id: e.provider_id, c: parseCidr(r.cidr), len: parseCidr(r.cidr).len });
}
const nameOf = (id) => (active.find(e => e.provider_id === id) || {}).provider_name || id;

// ---- HPR-001 §7.2 attribution (per IP) ----
function attribute(ip, asn /* optional */) {
  const ipInt = ipToInt(ip);
  // longest-prefix containment
  let rangeHit = null;
  for (const r of ranges) if (inCidr(ipInt, r.c)) { if (!rangeHit || r.len > rangeHit.len) rangeHit = r; }
  const rangeProvider = rangeHit ? rangeHit.provider_id : null;
  const asnProvider = (asn != null && asnIndex.has(asn)) ? asnIndex.get(asn) : null;
  // resolution
  if (rangeProvider && asnProvider) {
    if (rangeProvider === asnProvider) return { match_status: 'MAPPED', provider_id: rangeProvider, corroborated: true, via: 'range+asn' };
    return { match_status: 'CONFLICT', provider_id: null, candidates: [rangeProvider, asnProvider] };
  }
  if (rangeProvider) return { match_status: 'MAPPED', provider_id: rangeProvider, corroborated: false, via: 'range' };
  if (asnProvider) return { match_status: 'MAPPED', provider_id: asnProvider, corroborated: false, via: 'asn' };
  return { match_status: 'UNMAPPED', provider_id: null };
}

// ---- D3: attribution validation cases (synthetic IPs constructed against real v1 ranges) ----
const cases = [
  { name: 'range+ASN agree → MAPPED (corroborated) AWS', ip: '54.79.1.2', asn: 16509, expect: { s: 'MAPPED', p: 'HCP-001', corr: true } },
  { name: 'range only (no ASN) → MAPPED GCP', ip: '34.155.10.20', asn: null, expect: { s: 'MAPPED', p: 'HCP-003', corr: false } },
  { name: 'range only → MAPPED Azure (102.133.x in /19)', ip: '102.133.5.5', asn: null, expect: { s: 'MAPPED', p: 'HCP-002', corr: false } },
  { name: 'ASN only (IP outside all ranges) → MAPPED AWS via ASN', ip: '8.8.8.8', asn: 14618, expect: { s: 'MAPPED', p: 'HCP-001', corr: false } },
  { name: 'CONFLICT: IP in AWS range but ASN=Azure', ip: '3.40.1.1', asn: 8075, expect: { s: 'CONFLICT', p: null } },
  { name: 'UNMAPPED: no range, unknown ASN', ip: '8.8.8.8', asn: 64500, expect: { s: 'UNMAPPED', p: null } },
  { name: 'UNMAPPED: no range, no ASN', ip: '1.1.1.1', asn: null, expect: { s: 'UNMAPPED', p: null } },
  { name: 'GCP range, ASN=GCP agree → MAPPED corroborated', ip: '35.186.150.1', asn: 396982, expect: { s: 'MAPPED', p: 'HCP-003', corr: true } },
];

const fails = [];
console.log('# HPR-DATA-001 v1.0 — SEED VALIDATION (no live attribution; synthetic IPs)\n');
console.log(`dataset_version ${DS.dataset_version} | entries ${active.length} | ASN keys ${asnIndex.size} | range keys ${ranges.length}\n`);
console.log('## D3 — Attribution model');
for (const t of cases) {
  const r = attribute(t.ip, t.asn);
  let ok = r.match_status === t.expect.s && (r.provider_id || null) === (t.expect.p || null);
  if (t.expect.corr !== undefined) ok = ok && !!r.corroborated === t.expect.corr;
  if (!ok) fails.push(`${t.name}: got ${r.match_status}/${r.provider_id}/corr=${r.corroborated}`);
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${t.name.padEnd(48)} → ${r.match_status}${r.provider_id ? ' ' + nameOf(r.provider_id) : ''}${r.via ? ' (' + r.via + ')' : ''}`);
}

// ---- longest-prefix demonstration (synthetic overlapping fixture, NOT in v1.json) ----
console.log('\n## D3 — Longest-prefix precedence (synthetic overlap fixture)');
{
  const fx = [{ provider_id: 'P-BROAD', c: parseCidr('10.0.0.0/8'), len: 8 }, { provider_id: 'P-SPECIFIC', c: parseCidr('10.1.2.0/24'), len: 24 }];
  const ipInt = ipToInt('10.1.2.3');
  let hit = null; for (const r of fx) if (inCidr(ipInt, r.c)) { if (!hit || r.len > hit.len) hit = r; }
  const ok = hit && hit.provider_id === 'P-SPECIFIC';
  if (!ok) fails.push('longest-prefix did not select /24 over /8');
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] 10.1.2.3 in both /8 and /24 → selects ${hit && hit.provider_id} (longest prefix /${hit && hit.len})`);
}

// ---- determinism ----
{
  const a = JSON.stringify(attribute('54.79.1.2', 16509)), b = JSON.stringify(attribute('54.79.1.2', 16509));
  const ok = a === b; if (!ok) fails.push('non-deterministic');
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] determinism — identical input → identical output`);
}

// ---- D4: governance / schema / constitutional checks ----
console.log('\n## D4 — Governance & schema');
const g = [];
const ids = active.map(e => e.provider_id);
g.push(['provider_id unique', new Set(ids).size === ids.length]);
// ASN disjoint across providers
const asnSeen = new Map(); let asnDisjoint = true;
for (const e of active) for (const a of e.asns || []) { if (asnSeen.has(a) && asnSeen.get(a) !== e.provider_id) asnDisjoint = false; asnSeen.set(a, e.provider_id); }
g.push(['ASN keys disjoint across providers', asnDisjoint]);
// valid CIDRs
let validCidr = true; for (const e of active) for (const r of e.ip_ranges || []) { if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(r.cidr)) validCidr = false; }
g.push(['ip_ranges are valid IPv4 CIDRs', validCidr]);
// no cross-provider range overlap (ambiguity risk)
let overlap = false;
for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
  if (ranges[i].provider_id === ranges[j].provider_id) continue;
  const a = ranges[i].c, b = ranges[j].c;
  // overlap if one network contained in the other's mask
  if (((a.net & b.mask) >>> 0) === b.net || ((b.net & a.mask) >>> 0) === a.net) overlap = true;
}
g.push(['no cross-provider range overlap', !overlap]);
// provenance completeness
let prov = true; for (const e of active) { if (!e.evidence_class || !e.evidence_source) prov = false; for (const r of e.ip_ranges || []) if (!r.evidence_source || !r.snapshot_date) prov = false; if (e.version_added !== 1) prov = false; if (!(e.asns || []).length && !(e.ip_ranges || []).length) prov = false; }
g.push(['provenance complete (evidence + snapshot + version_added; ≥1 key)', prov]);
// no prohibited fields (Assessment-layer / scoring / reputation / geolocation-as-identity)
const FORBIDDEN = /(score|rank|reputation|resilience|concentration|quality|risk|market.?share|dependency|threat|geo|country|region|city|latitude|longitude)/i;
let clean = true; const scan = (o) => { if (o && typeof o === 'object') for (const k of Object.keys(o)) { if (FORBIDDEN.test(k)) clean = false; scan(o[k]); } };
scan(DS.entries);
g.push(['no prohibited (scoring/ranking/reputation/geo-identity) fields', clean]);
// versioning present
g.push(['dataset_version + governed_by present', DS.dataset_version === 1 && /HPR-001/.test(DS.governed_by)]);
for (const [name, ok] of g) { if (!ok) fails.push('[gov] ' + name); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`); }

console.log('\n## SUMMARY');
console.log(`  total checks: ${cases.length + 2 + g.length} | failures: ${fails.length}`);
if (fails.length) { fails.forEach(f => console.log('  FAIL', f)); process.exitCode = 1; }
else console.log('  ALL CHECKS PASS — model validated; dataset schema/governance clean.');
