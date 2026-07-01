'use strict';
// SOT-EMAILINFRA-001 §6 / IMP-EMAILINFRA-001 §3 — validation tooling (email).
// Validates: schema compliance, enum validity, two-decoder version recording,
// constitutional boundary, and the BACKEND-MASKING guardrail.
// Validation FAILS if: backend provider is inferred, Category A (SPF/DKIM/DMARC) evidence appears,
// IP/ASN attribution appears, or any prohibited field appears.

const REQUIRED = [
  'subject_domain', 'subject_etld1', 'collection_status', 'has_mx', 'mx_hosts', 'attributions',
  'distinct_email_operator_count', 'email_provision_model', 'email_provider_id', 'provider_class',
  'primary_email_provider_id', 'primary_provider_class', 'multi_provider', 'has_gateway',
  'epr_dataset_version', 'epr_spec_version', 'psl_version', 'signal_version', 'collector_version',
];
const MATCH_STATUS = new Set(['MAPPED', 'SELF_HOSTED', 'UNMAPPED', 'ATTRIBUTION_AMBIGUOUS']);
const MODELS = new Set(['THIRD_PARTY_SINGLE', 'THIRD_PARTY_MULTI', 'SELF_HOSTED', 'MIXED', 'UNDETERMINED', 'NO_MAIL']);
const PROVIDER_CLASS = new Set(['mailbox', 'gateway', 'transactional', null]);

// Any key whose presence would breach a constitutional boundary (Category A / IP-ASN / backend / scoring).
const FORBIDDEN_KEY = /(backend|spf|dkim|dmarc|dnssec|asn|\bip\b|ipv4|ipv6|cidr|netblock|registrar|registrant|whois|geo|score|rating|risk|resilience|concentration|trust_score)/i;

function scanForbidden(node, pathStr, out) {
  if (node == null) return;
  if (Array.isArray(node)) { node.forEach((v, i) => scanForbidden(v, `${pathStr}[${i}]`, out)); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      if (FORBIDDEN_KEY.test(k)) out.push(`${pathStr}.${k}`);
      scanForbidden(node[k], `${pathStr}.${k}`, out);
    }
  }
}

function validateRow(row) {
  const errors = [];
  for (const f of REQUIRED) if (!(f in row)) errors.push(`missing field: ${f}`);

  if (!MODELS.has(row.email_provision_model)) errors.push(`bad email_provision_model: ${row.email_provision_model}`);
  if (!PROVIDER_CLASS.has(row.provider_class)) errors.push(`bad provider_class: ${row.provider_class}`);
  if (!PROVIDER_CLASS.has(row.primary_provider_class)) errors.push(`bad primary_provider_class: ${row.primary_provider_class}`);

  for (const a of row.attributions || []) {
    if (!MATCH_STATUS.has(a.match_status)) errors.push(`bad match_status: ${a.match_status}`);
    if (a.match_status === 'MAPPED') {
      if (!a.provider_id) errors.push(`MAPPED without provider_id (${a.mx_host})`);
      if (!['DOCUMENTED_SUFFIX', 'ETLD1'].includes(a.match_type)) errors.push(`MAPPED bad match_type: ${a.match_type}`);
    } else if (a.provider_id) {
      errors.push(`non-MAPPED carries provider_id (${a.mx_host})`);
    }
  }

  // version recording (two decoders)
  if (!/^EPR-DATA-001\/v\d+/.test(row.epr_dataset_version || '')) errors.push('missing/bad epr_dataset_version');
  if (!/^psl@/.test(row.psl_version || '')) errors.push('missing/bad psl_version');

  // constitutional boundary + backend-masking guardrail
  const forbidden = [];
  scanForbidden(row, 'row', forbidden);
  for (const f of forbidden) errors.push(`FORBIDDEN field (boundary/backend-masking): ${f}`);

  return { ok: errors.length === 0, errors };
}

// Reproducibility: two rows for the same domain at the same versions must be identical modulo timestamp.
function reproducible(rowA, rowB) {
  const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.collection_timestamp; return JSON.stringify(c); };
  return strip(rowA) === strip(rowB);
}

module.exports = { validateRow, reproducible, REQUIRED, MATCH_STATUS, MODELS };
