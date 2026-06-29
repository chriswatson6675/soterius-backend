'use strict';
// SOT-DNSPROVISION-001 — signal orchestration (Layer A -> B -> C).
// Produces one evidence row per (signal, domain, run). Two-layer integrity: raw NS/SOA preserved;
// attribution recorded separately. Two-decoder version metadata (dataset + PSL) on every row.
const { etld1, PSL_VERSION } = require('./psl-processor');
const { loadDataset, buildIndex, attributeZone, deriveComposition } = require('./dpr-attribution');
const collector = require('./dnsprovision-collector');

const SIGNAL_ID = 'dnsprovision';
const SIGNAL_VERSION = 1;
const COLLECTOR_VERSION = 1;
const DPR_SPEC_VERSION = 'DPR-001 v1.0';
const SOT_SPEC_VERSION = 'SOT-DNSPROVISION-001 v1.0';

// runContext carries the loaded dataset + index (loaded once per run, SOT §11/PSD-001 §9.1).
function prepareRun(datasetFile) {
  const dataset = loadDataset(datasetFile);
  const { index, duplicates } = buildIndex(dataset);
  return { dataset, index, duplicates };
}

// Build one evidence row. `now` is injected for deterministic/reproducible tests.
// `observed` allows fixture injection: { childApex:{ns_hostnames,soa_mname,status}, parentDelegation:{...} }
async function collectDomain(domain, runCtx, { resolver, now, observed } = {}) {
  const subject_domain = String(domain).toLowerCase().replace(/\.$/, '');
  const subject_etld1 = etld1(subject_domain);

  const childApex = observed?.childApex || await collector.collectChildApex(subject_domain, resolver);
  const parentDelegation = observed?.parentDelegation || await collector.collectParentDelegation(subject_domain);

  const ns_hostnames = childApex.ns_hostnames || [];
  const ns_zones = [...new Set(ns_hostnames.map(etld1).filter(Boolean))].sort();
  const soa_mname = childApex.soa_mname || null;
  const soa_mname_zone = soa_mname ? etld1(soa_mname) : null;

  // Layer B — attribution per NS-zone.
  const attributions = ns_zones.map(z => {
    const a = attributeZone(z, subject_etld1, runCtx.index, runCtx.duplicates);
    a.soa_corroborated = !!(soa_mname_zone && soa_mname_zone === z);
    return a;
  });

  const collection_status = childApex.status;

  const composition = ns_zones.length
    ? deriveComposition(attributions)
    : {
        distinct_dns_operator_count: 0,
        // M4: a non-observation (no authoritative NS collected) must NOT be
        // labelled UNDETERMINED — that value is reserved for the §5 all-UNMAPPED
        // *evidence* case. When collection did not succeed no provision model is
        // asserted (null); `collection_status` carries the reason (Unknown ≠ Absent).
        dns_provision_model: collection_status === 'OK' ? 'UNDETERMINED' : null,
        primary_dns_provider_id: null,
        multi_provider: false,
      };

  // Parent-delegation divergence (corroboration). null when parent-delegation unavailable.
  let ns_delegation_divergence = null;
  if (parentDelegation && parentDelegation.status === 'OK' && Array.isArray(parentDelegation.parent_ns_hostnames)) {
    const parentSet = new Set(parentDelegation.parent_ns_hostnames.map(h => h.toLowerCase().replace(/\.$/, '')));
    const childSet = new Set(ns_hostnames);
    ns_delegation_divergence = !(parentSet.size === childSet.size && [...parentSet].every(x => childSet.has(x)));
  }

  return {
    // identity
    signal_id: SIGNAL_ID, signal_version: SIGNAL_VERSION, collector_version: COLLECTOR_VERSION,
    // Layer A (raw, preserved)
    subject_domain, subject_etld1,
    ns_source: 'child_apex',
    ns_hostnames, ns_zones,
    soa_mname, soa_mname_zone,
    parent_delegation_status: parentDelegation ? parentDelegation.status : null,
    ns_delegation_divergence,
    collection_status,
    // Layer C (evidence)
    attributions,
    distinct_dns_operator_count: composition.distinct_dns_operator_count,
    dns_provision_model: composition.dns_provision_model,
    // promoted scalars
    primary_dns_provider_id: composition.primary_dns_provider_id,
    multi_provider: composition.multi_provider,
    // reproducibility decoders + metadata
    dpr_dataset_version: runCtx.dataset.dataset_version,
    dpr_dataset_status: runCtx.dataset.status,
    dpr_spec_version: DPR_SPEC_VERSION,
    sot_spec_version: SOT_SPEC_VERSION,
    psl_version: PSL_VERSION,
    collection_timestamp: now || new Date().toISOString(),
  };
}

module.exports = { prepareRun, collectDomain, SIGNAL_ID, SIGNAL_VERSION };
