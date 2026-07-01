'use strict';
// SOT-CLOUDHOST-001 §6 — validation tooling (cloud/hosting). Schema, enum, version-stamp,
// constitutional-boundary, reproducibility. Validation FAILS on prohibited fields/inference.
const REQUIRED = ['subject_domain', 'collection_status', 'has_endpoint', 'resolved_ips', 'ip_attributions',
  'distinct_provider_count', 'distinct_asn_count', 'hosting_provision_model', 'primary_hosting_provider_id',
  'primary_provider_class', 'multi_provider', 'hpr_dataset_version', 'hpr_spec_version', 'ip_to_asn_source',
  'signal_version', 'collector_version'];
const MATCH = new Set(['MAPPED', 'UNMAPPED', 'CONFLICT']);
const MODELS = new Set(['SINGLE_PROVIDER', 'MULTI_PROVIDER', 'MIXED', 'UNDETERMINED', 'NO_ENDPOINT']);
const PROVIDER_CLASS = new Set(['hyperscale_cloud', 'managed_hosting', 'colocation', 'transit_isp', 'cdn_edge', 'other', null]);
// rir_country_of_allocation is an ALLOWED composition field (SLG-024 §6.4 caveat 1); whitelist it.
const ALLOWED = new Set(['rir_country_of_allocation']);
const FORBIDDEN = /(score|rank|reputation|resilience|concentration|diversity|dependency|quality|risk|threat|market.?share|\bgeo|country|region|city|latitude|longitude|certificate|dnssec|registrant|registrar|spf|dkim|dmarc)/i;

function scanForbidden(node, p, out) {
  if (node == null || typeof node !== 'object') return;
  for (const k of Object.keys(node)) {
    if (!ALLOWED.has(k) && FORBIDDEN.test(k)) out.push(`${p}.${k}`);
    scanForbidden(node[k], `${p}.${k}`, out);
  }
}

function validateRow(row) {
  const e = [];
  for (const f of REQUIRED) if (!(f in row)) e.push(`missing: ${f}`);
  if (!MODELS.has(row.hosting_provision_model)) e.push(`bad model: ${row.hosting_provision_model}`);
  if (!PROVIDER_CLASS.has(row.primary_provider_class)) e.push(`bad primary_provider_class: ${row.primary_provider_class}`);
  for (const a of row.ip_attributions || []) {
    if (!MATCH.has(a.match_status)) e.push(`bad match_status: ${a.match_status}`);
    if (a.match_status === 'MAPPED' && !a.provider_id) e.push(`MAPPED without provider_id (${a.ip})`);
    if (a.match_status !== 'MAPPED' && a.provider_id) e.push(`non-MAPPED carries provider_id (${a.ip})`);
    if ('confidence' in a || 'score' in a) e.push(`confidence/score present (${a.ip})`);
    // geolocation must never be an attribution input
    if ('cc' in a || 'country' in a || 'geo' in a) e.push(`geolocation in attribution (${a.ip})`);
  }
  if (!/^HPR-DATA-00\d\/v\d+/.test(row.hpr_dataset_version || '')) e.push('missing/bad hpr_dataset_version');
  if (!row.ip_to_asn_source) e.push('missing ip_to_asn_source (pinned decoder)');
  const forb = []; scanForbidden(row, 'row', forb);
  for (const f of forb) e.push(`FORBIDDEN field: ${f}`);
  return { ok: e.length === 0, errors: e };
}

function reproducible(a, b) {
  const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.collection_timestamp; return JSON.stringify(c); };
  return strip(a) === strip(b);
}

module.exports = { validateRow, reproducible, REQUIRED, MATCH, MODELS };
