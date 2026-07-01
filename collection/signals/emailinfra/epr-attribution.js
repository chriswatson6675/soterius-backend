'use strict';
// SOT-EMAILINFRA-001 §4–§5 / EPR-001 §7 — Layer B attribution engine (email).
// Sole attribution authority: EPR-001. Sole mapping source: EPR-DATA-001 (v1.json).
// Two-key exact matching only: DOCUMENTED_SUFFIX (longest-wins) and ETLD1.
// No fuzzy / substring(other than documented-suffix) / regex / wildcard / heuristic matching.
// BACKEND NEVER INFERRED (EPR-001 §12.2): a gateway MX is recorded as the observable gateway;
// the mailbox backend behind it is never inferred or stored.
const fs = require('fs');
const path = require('path');
const { etld1 } = require('../dnsprovision/psl-processor');

function loadDataset(file) {
  const p = file || path.join(__dirname, '..', '..', 'data', 'email-provider-reference', 'v1.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Build two exact-match indexes over ACTIVE entries:
//   etld1Index : eTLD+1 value (lowercased) -> {provider_id, provider_name, provider_class}
//   suffixList : [{value, provider_id, provider_name, provider_class}] sorted by length DESC (longest-wins)
// Duplicate key values across two providers are a dataset defect (EPR-001 §10 forbids):
// recorded in `duplicates` and resolved to ATTRIBUTION_AMBIGUOUS at match time.
function buildIndex(dataset) {
  const etld1Index = new Map();
  const suffixList = [];
  const seen = new Map();          // value -> provider_id (first writer)
  const duplicates = new Set();
  for (const e of dataset.entries) {
    if (e.status !== 'ACTIVE') continue;
    const meta = { provider_id: e.provider_id, provider_name: e.provider_name, provider_class: e.provider_class };
    for (const k of e.attribution_keys) {
      const v = String(k.value).toLowerCase();
      if (seen.has(v) && seen.get(v) !== e.provider_id) duplicates.add(v);
      seen.set(v, e.provider_id);
      if (k.match_type === 'DOCUMENTED_SUFFIX') suffixList.push({ value: v, ...meta });
      else if (k.match_type === 'ETLD1') etld1Index.set(v, meta);
    }
  }
  suffixList.sort((a, b) => b.value.length - a.value.length); // longest-suffix precedence
  return { etld1Index, suffixList, duplicates };
}

// Attribute a single MX host. subjectEtld1 enables the SELF_HOSTED branch (SOT §4 step).
// Branch order (binding): AMBIGUOUS > SELF_HOSTED > DOCUMENTED_SUFFIX(longest) > ETLD1 > UNMAPPED.
function attributeHost(mxHost, priority, subjectEtld1, idx) {
  const h = String(mxHost).toLowerCase().replace(/\.$/, '');
  const hEtld1 = etld1(h);
  const base = { mx_host: h, priority: priority == null ? null : priority, mx_etld1: hEtld1 };

  const suffixHit = idx.suffixList.find(s => h === s.value || h.endsWith('.' + s.value));
  const etld1Hit = hEtld1 && idx.etld1Index.get(hEtld1);

  // ambiguity: the would-be matched key value appears under >1 provider
  if ((suffixHit && idx.duplicates.has(suffixHit.value)) || (etld1Hit && idx.duplicates.has(hEtld1))) {
    return { ...base, match_status: 'ATTRIBUTION_AMBIGUOUS', match_type: null, provider_id: null, provider_name: null, provider_class: null };
  }
  // self-hosted: MX-host registrable domain == subject registrable domain
  if (subjectEtld1 && hEtld1 && hEtld1 === String(subjectEtld1).toLowerCase()) {
    return { ...base, match_status: 'SELF_HOSTED', match_type: null, provider_id: null, provider_name: null, provider_class: null };
  }
  if (suffixHit) {
    return { ...base, match_status: 'MAPPED', match_type: 'DOCUMENTED_SUFFIX',
      provider_id: suffixHit.provider_id, provider_name: suffixHit.provider_name, provider_class: suffixHit.provider_class };
  }
  if (etld1Hit) {
    return { ...base, match_status: 'MAPPED', match_type: 'ETLD1',
      provider_id: etld1Hit.provider_id, provider_name: etld1Hit.provider_name, provider_class: etld1Hit.provider_class };
  }
  return { ...base, match_status: 'UNMAPPED', match_type: null, provider_id: null, provider_name: null, provider_class: null };
}

// Derive per-domain composition (SOT §5/§6). Operator identity key:
//   MAPPED -> provider_id ; SELF_HOSTED -> 'SELF' ; UNMAPPED -> 'unmapped:'+mx_etld1 ; AMBIGUOUS -> 'ambiguous:'+mx_host
function deriveComposition(attributions) {
  const statuses = new Set(attributions.map(a => a.match_status));
  const operatorKeys = new Set(attributions.map(a => {
    if (a.match_status === 'MAPPED') return 'p:' + a.provider_id;
    if (a.match_status === 'SELF_HOSTED') return 'SELF';
    if (a.match_status === 'ATTRIBUTION_AMBIGUOUS') return 'ambiguous:' + a.mx_host;
    return 'unmapped:' + (a.mx_etld1 || a.mx_host);
  }));
  const distinct_email_operator_count = operatorKeys.size;
  const mappedIds = new Set(attributions.filter(a => a.match_status === 'MAPPED').map(a => a.provider_id));

  let email_provision_model;
  const only = (s) => statuses.size === 1 && statuses.has(s);
  if (only('SELF_HOSTED')) email_provision_model = 'SELF_HOSTED';
  else if (only('UNMAPPED')) email_provision_model = 'UNDETERMINED';
  else if (only('ATTRIBUTION_AMBIGUOUS')) email_provision_model = 'UNDETERMINED';
  else if (statuses.size === 1 && statuses.has('MAPPED')) {
    email_provision_model = mappedIds.size === 1 ? 'THIRD_PARTY_SINGLE' : 'THIRD_PARTY_MULTI';
  } else email_provision_model = 'MIXED';

  // primary operator = attribution of the lowest-priority MX (ties -> first seen)
  const primary = attributions.slice().sort((a, b) =>
    (a.priority == null ? Infinity : a.priority) - (b.priority == null ? Infinity : b.priority))[0] || null;

  const email_provider_id = (email_provision_model === 'THIRD_PARTY_SINGLE') ? [...mappedIds][0] : null;
  const provider_class = email_provider_id
    ? (attributions.find(a => a.provider_id === email_provider_id) || {}).provider_class || null
    : null;
  const has_gateway = attributions.some(a => a.match_status === 'MAPPED' && a.provider_class === 'gateway');

  return {
    distinct_email_operator_count,
    email_provision_model,
    email_provider_id,
    provider_class,
    primary_email_provider_id: primary && primary.match_status === 'MAPPED' ? primary.provider_id : null,
    primary_provider_class: primary ? primary.provider_class : null,
    multi_provider: distinct_email_operator_count > 1,
    has_gateway,
  };
}

module.exports = { loadDataset, buildIndex, attributeHost, deriveComposition };
