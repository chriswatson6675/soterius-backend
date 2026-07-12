'use strict';

// Security Headers canonical Observation adapter (Sprint 9 rollout). Mostly flat
// (JSONB https_fetch/http_probe/header_inventory) but the v2 collector emits two
// top-level fields (tls_verification_result, tls_error_code) with NO column in
// migration 014 — they are also preserved inside https_fetch, so buildObservation
// selects only the actual columns (they are not dropped from evidence, just from
// the top-level row). signal_securityheaders_v1 has a NOT NULL run_id column set
// to the canonical run id.

const { collectSecurityHeaders } = require('./securityheaders-collector');
const { buildObservationEnvelope } = require('../../../observatory/collection/observation-envelope');
const { OUTCOME } = require('../../../observatory/collection/observation-outcome');

const COLLECTOR = 'securityheaders';
const COLLECTOR_VERSION = 'securityheaders-collector@2.0.0';
const COLLECTION_METHOD = 'HTTPS';

// endpoint_state ∈ RESPONSE_OBSERVED | TLS_ERROR | CONNECTION_ERROR | TIMEOUT |
// REDIRECT_UNRESOLVED. A response observed = the header set was inventoried
// (PRESENT); sparse headers are a payload/scoring detail, not absence.
function deriveCollectionOutcome(facts) {
  if (facts.endpoint_state === 'RESPONSE_OBSERVED') return OUTCOME.OBSERVED_PRESENT;
  if (facts.endpoint_state === 'TLS_ERROR') return OUTCOME.COLLECTION_ERROR;
  return OUTCOME.NOT_OBSERVED;   // TIMEOUT / CONNECTION_ERROR / REDIRECT_UNRESOLVED
}

function buildSecurityHeadersObservation(input) {
  const { domain, facts, run } = input;
  if (!domain) throw new Error('domain is required');
  if (!facts || typeof facts !== 'object') throw new Error('collector facts are required');

  const observedAt = input.observedAt ?? facts.collected_at ?? new Date().toISOString();
  const envelope = buildObservationEnvelope({
    run,
    collector: COLLECTOR,
    collectorVersion: COLLECTOR_VERSION,
    collectionMethod: COLLECTION_METHOD,
    observedAt,
    collectionOutcome: deriveCollectionOutcome(facts),
    organisationId: input.organisationId ?? null,
    repositoryAuthorityRef: input.repositoryAuthorityRef ?? null,
  });

  // Select only real signal_securityheaders_v1 columns. tls_verification_result /
  // tls_error_code (v2 top-level, no column) are preserved inside https_fetch.
  return {
    domain,
    run_id: run.id,
    signal_version: facts.signal_version,
    endpoint_state: facts.endpoint_state,
    http_probe_state: facts.http_probe_state,
    https_fetch: facts.https_fetch,
    http_probe: facts.http_probe,
    header_inventory: facts.header_inventory,
    ...envelope,
  };
}

const securityHeadersAdapter = {
  signal: COLLECTOR,
  tableName: 'signal_securityheaders_v1',
  programme: { key: 'national-security-headers', name: 'National Security Headers', kind: 'NATIONAL', signal: 'securityheaders' },
  collect: (domain) => collectSecurityHeaders(domain, COLLECTOR_VERSION),
  buildObservation: buildSecurityHeadersObservation,
};

module.exports = { deriveCollectionOutcome, buildSecurityHeadersObservation, securityHeadersAdapter };
