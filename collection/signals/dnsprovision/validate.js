'use strict';
// SOT-DNSPROVISION-001 §7 / IMP-DNSPROVISION-001 §4 — validation harness.
// Schema, boundary (constitutional), and reproducibility checks.

const REQUIRED = ['signal_id', 'subject_domain', 'subject_etld1', 'ns_source', 'ns_hostnames',
  'ns_zones', 'attributions', 'distinct_dns_operator_count', 'dns_provision_model',
  'dpr_dataset_version', 'psl_version', 'collection_timestamp'];
const VALID_STATUS = ['MAPPED', 'SELF_OPERATED', 'UNMAPPED', 'ATTRIBUTION_AMBIGUOUS'];
const VALID_MODEL = ['SELF_OPERATED', 'THIRD_PARTY_SINGLE', 'THIRD_PARTY_MULTI', 'MIXED', 'UNDETERMINED'];

// Forbidden FIELD-NAME patterns — no Category E (registrar/registrant), B (DNSSEC/CAA),
// D (certificate), A (SPF/DKIM/DMARC), IP/ASN, or Assessment-layer field may appear.
const FORBIDDEN_KEY = [/asn/i, /\bip\b/i, /cidr/i, /registrar/i, /registrant/i, /\brdap\b/i,
  /concentration/i, /prevalence/i, /market.?share/i, /resilience/i, /dependency/i,
  /\bscore\b/i, /\brating\b/i, /threat/i, /reputation/i,
  /dnssec/i, /\bcaa\b/i, /certificate/i, /\bspf\b/i, /dkim/i, /dmarc/i];

function validateSchema(row) {
  const errors = [];
  for (const k of REQUIRED) if (!(k in row)) errors.push(`missing field: ${k}`);
  if (row.ns_source !== 'child_apex') errors.push(`ns_source must be child_apex (got ${row.ns_source})`);
  if (!Array.isArray(row.ns_hostnames)) errors.push('ns_hostnames must be array');
  if (!Array.isArray(row.attributions)) errors.push('attributions must be array');
  if (!VALID_MODEL.includes(row.dns_provision_model)) errors.push(`invalid dns_provision_model: ${row.dns_provision_model}`);
  for (const a of row.attributions || []) {
    if (!VALID_STATUS.includes(a.match_status)) errors.push(`invalid match_status: ${a.match_status}`);
    if (a.match_status === 'MAPPED' && !a.provider_id) errors.push(`MAPPED without provider_id (${a.ns_zone})`);
    if (a.match_status !== 'MAPPED' && a.provider_id) errors.push(`non-MAPPED with provider_id (${a.ns_zone})`);
  }
  // no numeric confidence score (confidence is match_status only)
  if ('confidence' in row || 'confidence_score' in row) errors.push('numeric confidence score forbidden (match_status only)');
  return errors;
}

function collectKeys(obj, acc = []) {
  if (Array.isArray(obj)) { obj.forEach(o => collectKeys(o, acc)); return acc; }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) { acc.push(k); collectKeys(obj[k], acc); }
  }
  return acc;
}

function validateBoundary(row) {
  const violations = [];
  for (const key of collectKeys(row)) {
    for (const re of FORBIDDEN_KEY) if (re.test(key)) { violations.push(`forbidden field "${key}" (matched ${re})`); break; }
  }
  return violations;
}

// Reproducibility: two rows for the same domain/versions must match (ignoring timestamp).
function reproducible(rowA, rowB) {
  const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.collection_timestamp; return c; };
  return JSON.stringify(strip(rowA)) === JSON.stringify(strip(rowB));
}

module.exports = { validateSchema, validateBoundary, reproducible, REQUIRED };
