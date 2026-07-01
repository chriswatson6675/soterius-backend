'use strict';
// SOT-CLOUDHOST-001 §6 — Cloud / Hosting Provider Identity signal orchestration.
// Layer A (resolve A/AAAA + IP→ASN) → Layer B (HPR exact-match) → Layer C (composition + evidence row).
// Two-decoder version stamps (HPR dataset version + spec version + pinned IP→ASN source) per row.
// Composition fact only; no concentration/resilience/risk; geolocation never an attribution input.
const { collect, ipToAsnSource } = require('./cloudhost-collector');
const { loadDataset, buildIndex, attributeIp, deriveComposition } = require('./hpr-attribution');

const SIGNAL_VERSION = 'SOT-CLOUDHOST-001/v1.0';
const COLLECTOR_VERSION = 'cloudhost-collector/1.0';

function makeAttributor(dataset) {
  const ds = dataset || loadDataset();
  const idx = buildIndex(ds);
  return { ds, idx,
    datasetVersion: (ds.dataset_id || 'HPR-DATA-001') + '/v' + ds.dataset_version,
    specVersion: ds.governed_by || 'HPR-001',
    frozen: !!(ds.freeze && ds.freeze.frozen) };
}

// Build an evidence row from an already-collected observation (no network) — used by fixtures + live.
function attributeObservation(domain, obs, attributor, timestamp) {
  const ip_attributions = (obs.resolved_ips || []).map(r => {
    const a = attributeIp(r.ip, r.asn, attributor.idx);
    return { ip: a.ip, version: r.version, asn: r.asn, bgp_prefix: r.bgp_prefix, rir: r.rir,
      match_status: a.match_status, via: a.via, provider_id: a.provider_id, provider_name: a.provider_name,
      provider_class: a.provider_class, corroborated: a.corroborated };
  });
  const composition = obs.has_endpoint
    ? deriveComposition(ip_attributions)
    : { distinct_provider_count: 0, distinct_asn_count: 0, distinct_operator_count: 0, hosting_provision_model: 'NO_ENDPOINT', primary_hosting_provider_id: null, primary_provider_class: null, multi_provider: false };
  // optional C-F6 field: RIR country-of-allocation per IP (composition context only; never an attribution input)
  const rir_country_of_allocation = [...new Set((obs.resolved_ips || []).map(r => r.cc).filter(Boolean))];

  return {
    subject_domain: String(domain).toLowerCase(),
    collection_status: obs.status,
    has_endpoint: !!obs.has_endpoint,
    resolved_ips: (obs.resolved_ips || []).map(r => ({ ip: r.ip, version: r.version, asn: r.asn, bgp_prefix: r.bgp_prefix })), // Layer A raw
    ip_attributions,                                                  // Layer B
    distinct_provider_count: composition.distinct_provider_count,     // Layer C
    distinct_asn_count: composition.distinct_asn_count,               // folded C-F5
    hosting_provision_model: composition.hosting_provision_model,
    primary_hosting_provider_id: composition.primary_hosting_provider_id,
    primary_provider_class: composition.primary_provider_class,
    multi_provider: composition.multi_provider,
    rir_country_of_allocation,                                        // optional C-F6 (not an attribution key)
    hpr_dataset_version: attributor.datasetVersion,                   // decoder 2
    hpr_spec_version: attributor.specVersion,
    ip_to_asn_source: ipToAsnSource,                                  // decoder 1 (pinned)
    signal_version: SIGNAL_VERSION,
    collector_version: COLLECTOR_VERSION,
    collection_timestamp: timestamp || null,
  };
}

async function runDomain(domain, attributor, opts) {
  const a = attributor || makeAttributor();
  const obs = await collect(domain, opts);
  return attributeObservation(domain, obs, a, (opts && opts.timestamp) || null);
}

module.exports = { makeAttributor, attributeObservation, runDomain, SIGNAL_VERSION, COLLECTOR_VERSION };
