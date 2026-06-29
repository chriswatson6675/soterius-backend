'use strict';
// SOT-DNSPROVISION-001 §5 / DPR-001 §7 — Layer B attribution engine.
// Sole attribution authority: DPR-001. Sole mapping source: DPR-DATA-001 (v1.json).
// Exact NS-zone match only. No fuzzy / substring / regex / wildcard / heuristic matching.
const fs = require('fs');
const path = require('path');

function loadDataset(file) {
  const p = file || path.join(__dirname, '..', '..', 'data', 'dns-provider-reference', 'v1.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Build an exact-match index ns_zone(lowercased) -> {provider_id, provider_name}.
// Detects duplicate zones across ACTIVE entries (a dataset defect; DPR-001 §10.3 forbids).
function buildIndex(dataset) {
  const index = new Map();
  const duplicates = [];
  for (const e of dataset.entries) {
    if (e.status !== 'ACTIVE') continue;
    for (const z of e.ns_zones) {
      const zl = String(z).toLowerCase();
      if (index.has(zl) && index.get(zl).provider_id !== e.provider_id) duplicates.push(zl);
      index.set(zl, { provider_id: e.provider_id, provider_name: e.provider_name });
    }
  }
  return { index, duplicates };
}

// Attribute a single NS-zone. subjectEtld1 enables the SELF_OPERATED branch (SOT §4.4 step 1).
function attributeZone(nsZone, subjectEtld1, index, duplicates) {
  const z = String(nsZone).toLowerCase();
  if (duplicates && duplicates.includes(z)) {
    return { ns_zone: nsZone, match_status: 'ATTRIBUTION_AMBIGUOUS', provider_id: null, provider_name: null };
  }
  if (subjectEtld1 && z === String(subjectEtld1).toLowerCase()) {
    return { ns_zone: nsZone, match_status: 'SELF_OPERATED', provider_id: null, provider_name: null };
  }
  if (index.has(z)) {
    const p = index.get(z);
    return { ns_zone: nsZone, match_status: 'MAPPED', provider_id: p.provider_id, provider_name: p.provider_name };
  }
  return { ns_zone: nsZone, match_status: 'UNMAPPED', provider_id: null, provider_name: null };
}

// Derive per-domain composition (SOT §5). Operator identity key:
//   MAPPED -> provider_id ; SELF_OPERATED -> 'SELF' ; UNMAPPED -> 'unmapped:'+zone ; AMBIGUOUS -> 'ambiguous:'+zone
function deriveComposition(attributions) {
  const statuses = new Set(attributions.map(a => a.match_status));
  const operatorKeys = new Set(attributions.map(a => {
    if (a.match_status === 'MAPPED') return 'p:' + a.provider_id;
    if (a.match_status === 'SELF_OPERATED') return 'SELF';
    if (a.match_status === 'ATTRIBUTION_AMBIGUOUS') return 'ambiguous:' + a.ns_zone.toLowerCase();
    return 'unmapped:' + a.ns_zone.toLowerCase();
  }));
  const distinct_dns_operator_count = operatorKeys.size;
  const mappedProviderIds = new Set(attributions.filter(a => a.match_status === 'MAPPED').map(a => a.provider_id));

  let dns_provision_model;
  const only = (s) => statuses.size === 1 && statuses.has(s);
  if (only('SELF_OPERATED')) dns_provision_model = 'SELF_OPERATED';
  else if (only('UNMAPPED')) dns_provision_model = 'UNDETERMINED';
  else if (statuses.size === 1 && statuses.has('MAPPED')) {
    dns_provision_model = mappedProviderIds.size === 1 ? 'THIRD_PARTY_SINGLE' : 'THIRD_PARTY_MULTI';
  } else if (only('ATTRIBUTION_AMBIGUOUS')) dns_provision_model = 'UNDETERMINED';
  else dns_provision_model = 'MIXED';

  // primary_dns_provider_id: only when exactly one third-party operator and no self/unmapped mix
  const primary_dns_provider_id = (dns_provision_model === 'THIRD_PARTY_SINGLE') ? [...mappedProviderIds][0] : null;
  const multi_provider = distinct_dns_operator_count > 1;
  return { distinct_dns_operator_count, dns_provision_model, primary_dns_provider_id, multi_provider };
}

module.exports = { loadDataset, buildIndex, attributeZone, deriveComposition };
