'use strict';
// SOT-EMAILINFRA-001 §6 — Email Infrastructure Identity signal orchestration.
// Layer A (collect MX) -> Layer B (two-key attribution) -> Layer C (composition).
// Emits one evidence row per subject domain, stamped with EPR dataset + PSL versions (two decoders).
// Constitutional: MX-only; no SPF/DKIM/DMARC; no IP/ASN; no backend inference; no Assessment-layer scoring.
const { collectMx } = require('./emailinfra-collector');
const { loadDataset, buildIndex, attributeHost, deriveComposition } = require('./epr-attribution');
const { etld1, PSL_VERSION } = require('../dnsprovision/psl-processor');

const SIGNAL_VERSION = 'SOT-EMAILINFRA-001/v1.0';
const COLLECTOR_VERSION = 'emailinfra-collector/1.0';

function makeAttributor(dataset) {
  const ds = dataset || loadDataset();
  const idx = buildIndex(ds);
  const datasetVersion = 'EPR-DATA-001/v' + ds.dataset_version;
  const specVersion = ds.governed_by || 'EPR-001';
  return { ds, idx, datasetVersion, specVersion };
}

// Build an evidence row from an already-collected MX observation (no network) — used by fixtures + live alike.
function attributeObservation(domain, observation, attributor, timestamp) {
  const subjectEtld1 = etld1(domain);
  const attributions = (observation.mx_hosts || []).map(m =>
    attributeHost(m.host, m.priority, subjectEtld1, attributor.idx));
  // M2: mx_zones[] is a specified evidence-block field (§6.1) — the deduped
  // eTLD+1 set across the MX hosts.
  const mx_zones = [...new Set(attributions.map(a => a.mx_etld1).filter(Boolean))].sort();
  const composition = observation.has_mx
    ? deriveComposition(attributions)
    // M1: when no MX is observed, no provision model is asserted (null). The
    // §6.1 vocabulary {SELF_HOSTED|THIRD_PARTY_SINGLE|THIRD_PARTY_MULTI|MIXED|
    // UNDETERMINED} describes observed mail-transport; absence/non-observation
    // is carried by has_mx + collection_status (Unknown ≠ Absent), not by an
    // out-of-vocabulary value.
    : { distinct_email_operator_count: 0, email_provision_model: null, email_provider_id: null,
        provider_class: null, primary_email_provider_id: null, primary_provider_class: null,
        multi_provider: false, has_gateway: false };

  return {
    subject_domain: String(domain).toLowerCase(),
    subject_etld1: subjectEtld1,
    collection_status: observation.status,
    has_mx: observation.has_mx,
    // Layer A — raw, preserved verbatim
    mx_hosts: observation.mx_hosts,
    mx_zones,
    // Layer B — per-host attribution
    attributions,
    // Layer C — composition (documentary; non-scoring)
    distinct_email_operator_count: composition.distinct_email_operator_count,
    email_provision_model: composition.email_provision_model,
    email_provider_id: composition.email_provider_id,
    provider_class: composition.provider_class,
    primary_email_provider_id: composition.primary_email_provider_id,
    primary_provider_class: composition.primary_provider_class,
    multi_provider: composition.multi_provider,
    has_gateway: composition.has_gateway,
    // Two-decoder versioning (binding, every row)
    epr_dataset_version: attributor.datasetVersion,
    epr_spec_version: attributor.specVersion,
    psl_version: PSL_VERSION,
    signal_version: SIGNAL_VERSION,
    collector_version: COLLECTOR_VERSION,
    collection_timestamp: timestamp || null,
  };
}

// Full live run for one domain.
async function runDomain(domain, attributor, opts) {
  const a = attributor || makeAttributor();
  const observation = await collectMx(domain, undefined, opts);
  return attributeObservation(domain, observation, a, (opts && opts.timestamp) || null);
}

module.exports = { makeAttributor, attributeObservation, runDomain, SIGNAL_VERSION, COLLECTOR_VERSION };
