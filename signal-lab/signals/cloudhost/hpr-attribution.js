'use strict';
// SOT-CLOUDHOST-001 §5 / HPR-001 §7 — Layer B attribution engine (cloud/hosting).
// Sole attribution authority: HPR-001. Sole mapping source: HPR-DATA-001 (frozen v1.json).
// Two deterministic keys: longest-prefix IP_RANGE_CONTAINMENT + exact ASN. Precedence range>ASN.
// No fuzzy / regex / org-name / ML / geolocation / confidence-score attribution.
const fs = require('fs');
const path = require('path');

function loadDataset(file) {
  const p = file || path.join(__dirname, '..', '..', 'data', 'hosting-provider-reference', 'v1.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const ipToInt = (ip) => ip.split('.').reduce((a, o) => (a << 8 >>> 0) + (+o), 0) >>> 0;
function parseCidr(c) { const [ip, bits] = c.split('/'); const len = +bits; const mask = len === 0 ? 0 : (0xFFFFFFFF << (32 - len)) >>> 0; return { net: (ipToInt(ip) & mask) >>> 0, len, mask }; }
const inCidr = (ipInt, c) => ((ipInt & c.mask) >>> 0) === c.net;

// Build index over ACTIVE entries. duplicates (same ASN under 2 providers) = dataset defect.
function buildIndex(dataset) {
  const asnIndex = new Map();      // asn -> provider_id
  const ranges = [];               // {provider_id, cidr:parsed, len}
  const meta = new Map();          // provider_id -> {provider_name, provider_class}
  const asnDup = new Set();
  for (const e of dataset.entries) {
    if (e.status !== 'ACTIVE') continue;
    meta.set(e.provider_id, { provider_name: e.provider_name, provider_class: e.provider_class });
    for (const a of (e.asns || [])) { if (asnIndex.has(a) && asnIndex.get(a) !== e.provider_id) asnDup.add(a); asnIndex.set(a, e.provider_id); }
    for (const r of (e.ip_ranges || [])) { const c = parseCidr(r.cidr); ranges.push({ provider_id: e.provider_id, c, len: c.len }); }
  }
  return { asnIndex, ranges, meta, asnDup };
}

// Attribute a single IP (+ optional decoded asn). HPR-001 §7.2.
function attributeIp(ip, asn, idx) {
  const base = { ip, asn: asn == null ? null : asn };
  if (ip.includes(':')) {
    // IPv6 ranges not in v1 seed (Tier-1 published v4 subset); attribute by ASN only.
    const ap = (asn != null && idx.asnIndex.has(asn)) ? idx.asnIndex.get(asn) : null;
    if (ap) { const m = idx.meta.get(ap); return { ...base, match_status: 'MAPPED', via: 'asn', provider_id: ap, provider_name: m.provider_name, provider_class: m.provider_class, corroborated: false }; }
    return { ...base, match_status: 'UNMAPPED', via: null, provider_id: null, provider_name: null, provider_class: null, corroborated: false };
  }
  const ipInt = ipToInt(ip);
  let rangeHit = null;
  for (const r of idx.ranges) if (inCidr(ipInt, r.c)) { if (!rangeHit || r.len > rangeHit.len) rangeHit = r; }  // longest-prefix
  const rangeProvider = rangeHit ? rangeHit.provider_id : null;
  const asnProvider = (asn != null && idx.asnIndex.has(asn)) ? idx.asnIndex.get(asn) : null;
  if (asn != null && idx.asnDup.has(asn)) return { ...base, match_status: 'CONFLICT', via: 'asn-ambiguous', provider_id: null, provider_name: null, provider_class: null, corroborated: false };
  let res;
  if (rangeProvider && asnProvider) {
    if (rangeProvider === asnProvider) res = { match_status: 'MAPPED', via: 'range+asn', provider_id: rangeProvider, corroborated: true };
    else res = { match_status: 'CONFLICT', via: 'range!=asn', provider_id: null, corroborated: false, candidates: [rangeProvider, asnProvider] };
  } else if (rangeProvider) res = { match_status: 'MAPPED', via: 'range', provider_id: rangeProvider, corroborated: false };
  else if (asnProvider) res = { match_status: 'MAPPED', via: 'asn', provider_id: asnProvider, corroborated: false };
  else res = { match_status: 'UNMAPPED', via: null, provider_id: null, corroborated: false };
  const m = res.provider_id ? idx.meta.get(res.provider_id) : null;
  return { ...base, ...res, provider_name: m ? m.provider_name : null, provider_class: m ? m.provider_class : null };
}

// Per-domain composition (SOT-CLOUDHOST-001 §5/§6). Operator key: provider_id | 'conflict:'+ip | 'unmapped:'+(asn||ip)
function deriveComposition(attributions) {
  const statuses = new Set(attributions.map(a => a.match_status));
  const opKeys = new Set(attributions.map(a => a.match_status === 'MAPPED' ? 'p:' + a.provider_id : a.match_status === 'CONFLICT' ? 'conflict:' + a.ip : 'unmapped:' + (a.asn || a.ip)));
  const mappedIds = new Set(attributions.filter(a => a.match_status === 'MAPPED').map(a => a.provider_id));
  const distinct_provider_count = mappedIds.size;
  const distinct_operator_count = opKeys.size;
  const distinct_asn_count = new Set(attributions.map(a => a.asn).filter(x => x != null)).size;

  let hosting_provision_model;
  const only = (s) => statuses.size === 1 && statuses.has(s);
  if (only('UNMAPPED') || only('CONFLICT')) hosting_provision_model = 'UNDETERMINED';
  else if (statuses.size === 1 && statuses.has('MAPPED')) hosting_provision_model = mappedIds.size === 1 ? 'SINGLE_PROVIDER' : 'MULTI_PROVIDER';
  else hosting_provision_model = 'MIXED';  // mapped + (unmapped|conflict)

  const primary_hosting_provider_id = (hosting_provision_model === 'SINGLE_PROVIDER') ? [...mappedIds][0] : null;
  const primaryAttr = attributions.find(a => a.provider_id === primary_hosting_provider_id);
  return {
    distinct_provider_count, distinct_asn_count, distinct_operator_count,
    hosting_provision_model,
    primary_hosting_provider_id,
    primary_provider_class: primaryAttr ? primaryAttr.provider_class : null,
    multi_provider: distinct_provider_count > 1,
  };
}

module.exports = { loadDataset, buildIndex, attributeIp, deriveComposition, parseCidr, inCidr, ipToInt };
