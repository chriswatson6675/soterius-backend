'use strict';

// dnsprovision.test.js — SOT-DNSPROVISION-001 conformance test suite (H1).
//
// Establishes the previously-absent automated coverage for the foundational
// Category F signal. No live DNS, no database: a fake resolver and an inline
// fixture dataset drive the two-layer pipeline (Layer A collector → Layer B
// attribution → Layer C signal assembly).
//
// Run: node --test backend/signal-lab/signals/dnsprovision/dnsprovision.test.js

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildIndex, attributeZone, deriveComposition } = require('./dpr-attribution');
const { collectChildApex, classify } = require('./dnsprovision-collector');
const { collectDomain } = require('./dnsprovision-signal');
const { PSL_VERSION } = require('./psl-processor');

const NOW = '2026-06-27T00:00:00.000Z';

// Inline fixture mapping dataset (mirrors DPR-DATA-001 shape). Exact-zone match only.
const DATASET = {
  dataset_id: 'DPR-DATA-001', dataset_version: 1, status: 'TEST',
  entries: [
    { provider_id: 'DNSP-001', provider_name: 'Cloudflare',  status: 'ACTIVE',  ns_zones: ['cloudflare.com'] },
    { provider_id: 'DNSP-002', provider_name: 'AWS Route 53', status: 'ACTIVE',  ns_zones: ['awsdns-01.org', 'awsdns-02.net'] },
    { provider_id: 'DNSP-OLD', provider_name: 'Retired Co',  status: 'RETIRED', ns_zones: ['oldzone.com'] },        // must be ignored
    { provider_id: 'DNSP-DUPA', provider_name: 'Dup A',      status: 'ACTIVE',  ns_zones: ['dupzone.com'] },
    { provider_id: 'DNSP-DUPB', provider_name: 'Dup B',      status: 'ACTIVE',  ns_zones: ['dupzone.com'] },        // duplicate → ambiguous
  ],
};

function runCtx() {
  const { index, duplicates } = buildIndex(DATASET);
  return { dataset: DATASET, index, duplicates };
}

function childApex(ns_hostnames, soa_mname = null, status = 'OK') {
  return { ns_hostnames, soa_mname, status };
}

async function collect(domain, observedChildApex) {
  return collectDomain(domain, runCtx(), { now: NOW, observed: { childApex: observedChildApex } });
}

// ── Layer B: dataset index ───────────────────────────────────────────────────────

describe('dpr-attribution — index build', () => {
  test('ignores non-ACTIVE entries', () => {
    const { index } = buildIndex(DATASET);
    assert.ok(index.has('cloudflare.com'));
    assert.ok(!index.has('oldzone.com'), 'RETIRED entry must not be indexed');
  });

  test('detects duplicate zones across ACTIVE entries (DPR-001 §10.3 defect)', () => {
    const { duplicates } = buildIndex(DATASET);
    assert.ok(duplicates.includes('dupzone.com'));
  });
});

// ── Layer B: per-zone attribution (SOT §4.4 / §5) ─────────────────────────────────

describe('dpr-attribution — attributeZone', () => {
  const { index, duplicates } = buildIndex(DATASET);

  test('MAPPED: exact zone match yields provider', () => {
    const a = attributeZone('cloudflare.com', 'acme.com', index, duplicates);
    assert.equal(a.match_status, 'MAPPED');
    assert.equal(a.provider_id, 'DNSP-001');
  });

  test('SELF_OPERATED: zone equals subject eTLD+1', () => {
    const a = attributeZone('acme.com', 'acme.com', index, duplicates);
    assert.equal(a.match_status, 'SELF_OPERATED');
    assert.equal(a.provider_id, null);
  });

  test('UNMAPPED: no match and not self-operated', () => {
    const a = attributeZone('unknown-zone.net', 'acme.com', index, duplicates);
    assert.equal(a.match_status, 'UNMAPPED');
    assert.equal(a.provider_id, null);
  });

  test('ATTRIBUTION_AMBIGUOUS: duplicate dataset zone preserved, no provider asserted', () => {
    const a = attributeZone('dupzone.com', 'acme.com', index, duplicates);
    assert.equal(a.match_status, 'ATTRIBUTION_AMBIGUOUS');
    assert.equal(a.provider_id, null);
  });

  test('matching is case-insensitive', () => {
    const a = attributeZone('CloudFlare.COM', 'acme.com', index, duplicates);
    assert.equal(a.match_status, 'MAPPED');
  });
});

// ── Layer C: provision-model derivation (SOT §5) ──────────────────────────────────

describe('signal — provision model derivation', () => {
  test('THIRD_PARTY_SINGLE: all NS map to one provider; primary set; soa corroborated', async () => {
    const row = await collect('acme.com', childApex(['ns1.cloudflare.com', 'ns2.cloudflare.com'], 'ns1.cloudflare.com'));
    assert.equal(row.dns_provision_model, 'THIRD_PARTY_SINGLE');
    assert.equal(row.primary_dns_provider_id, 'DNSP-001');
    assert.equal(row.multi_provider, false);
    assert.equal(row.distinct_dns_operator_count, 1);
    const cf = row.attributions.find(a => a.ns_zone === 'cloudflare.com');
    assert.equal(cf.soa_corroborated, true);
  });

  test('THIRD_PARTY_MULTI: two distinct mapped providers; no primary', async () => {
    const row = await collect('acme.com', childApex(['ns1.cloudflare.com', 'ns1.awsdns-01.org']));
    assert.equal(row.dns_provision_model, 'THIRD_PARTY_MULTI');
    assert.equal(row.primary_dns_provider_id, null);
    assert.equal(row.multi_provider, true);
    assert.equal(row.distinct_dns_operator_count, 2);
  });

  test('SELF_OPERATED: all NS in subject zone', async () => {
    const row = await collect('acme.com', childApex(['ns1.acme.com', 'ns2.acme.com']));
    assert.equal(row.dns_provision_model, 'SELF_OPERATED');
    assert.equal(row.primary_dns_provider_id, null);
  });

  test('MIXED: mapped + self-operated', async () => {
    const row = await collect('acme.com', childApex(['ns1.cloudflare.com', 'ns1.acme.com']));
    assert.equal(row.dns_provision_model, 'MIXED');
  });

  test('UNDETERMINED: NS present but all unmapped (the §5 evidence case)', async () => {
    const row = await collect('acme.com', childApex(['ns1.unknown-zone.net']));
    assert.equal(row.dns_provision_model, 'UNDETERMINED');
    assert.equal(row.collection_status, 'OK');
  });

  test('soa_corroborated is false when SOA zone differs from the NS zone', async () => {
    const row = await collect('acme.com', childApex(['ns1.cloudflare.com'], 'ns1.awsdns-01.org'));
    const cf = row.attributions.find(a => a.ns_zone === 'cloudflare.com');
    assert.equal(cf.soa_corroborated, false);
  });
});

// ── M4: non-observation must not be labelled UNDETERMINED ──────────────────────────

describe('signal — M4 non-observation handling', () => {
  test('DNS failure: no provision model asserted (null), collection_status preserved', async () => {
    const row = await collect('acme.com', childApex([], null, 'DNS_TIMEOUT'));
    assert.equal(row.dns_provision_model, null, 'a non-observation must not be UNDETERMINED');
    assert.equal(row.collection_status, 'DNS_TIMEOUT');
    assert.equal(row.distinct_dns_operator_count, 0);
  });

  test('UNDETERMINED (all-unmapped) and null (non-observation) are distinguishable', async () => {
    const unmapped = await collect('acme.com', childApex(['ns1.unknown-zone.net']));
    const failed   = await collect('acme.com', childApex([], null, 'DNS_FAILURE'));
    assert.equal(unmapped.dns_provision_model, 'UNDETERMINED');
    assert.equal(failed.dns_provision_model, null);
  });
});

// ── M1: parent-delegation scoped deferral (honest non-observation) ────────────────

describe('signal — M1 parent-delegation deferral', () => {
  test('parent delegation unavailable → divergence null (never false), status preserved', async () => {
    const row = await collect('acme.com', childApex(['ns1.cloudflare.com']));
    assert.equal(row.parent_delegation_status, 'PARENT_DELEGATION_UNAVAILABLE');
    assert.equal(row.ns_delegation_divergence, null, 'unknown divergence must be null, not false');
  });
});

// ── Reproducibility metadata (SOT §3.4 / §6.1) ────────────────────────────────────

describe('signal — reproducibility metadata', () => {
  test('records dataset version, PSL version, spec versions, and ns_source', async () => {
    const row = await collect('acme.com', childApex(['ns1.cloudflare.com']));
    assert.equal(row.dpr_dataset_version, 1);
    assert.equal(row.psl_version, PSL_VERSION);
    assert.ok(row.dpr_spec_version);
    assert.ok(row.sot_spec_version);
    assert.equal(row.ns_source, 'child_apex');
    assert.equal(row.collection_timestamp, NOW);
  });
});

// ── Layer A: collector normalisation + classification ─────────────────────────────

describe('collector — Layer A normalisation', () => {
  test('NS hostnames are deduped, lowercased, trailing-dot stripped, sorted', async () => {
    const resolver = {
      resolveNs: async () => ['NS2.Cloudflare.com.', 'ns1.cloudflare.com', 'ns1.cloudflare.com'],
      resolveSoa: async () => ({ nsname: 'NS1.Cloudflare.com.' }),
    };
    const out = await collectChildApex('ACME.com', resolver);
    assert.deepEqual(out.ns_hostnames, ['ns1.cloudflare.com', 'ns2.cloudflare.com']);
    assert.equal(out.soa_mname, 'ns1.cloudflare.com');
    assert.equal(out.status, 'OK');
  });

  test('classify maps DNS error codes to evidence/process states', () => {
    assert.equal(classify({ code: 'ETIMEDOUT' }), 'DNS_TIMEOUT');
    assert.equal(classify({ code: 'ENOTFOUND' }), 'ABSENT');
    assert.equal(classify({ code: 'ESERVFAIL' }), 'DNS_FAILURE');
  });
});
