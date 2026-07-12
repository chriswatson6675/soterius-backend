'use strict';

// TLS canonical Observation adapter (Sprint 9 rollout). TLS DEVIATES from the flat
// pattern: signal_tls_v1 stores the full extractor object in an `evidence` JSONB
// column plus a promoted scalar subset — NOT a flat facts spread. buildObservation
// reproduces that existing shape (evidence + promotedScalars) and adds the
// envelope. The table's pre-existing `run_id` column (a collector-local id) is set
// to the canonical run id alongside the new collection_run_id.

const { promotedScalars } = require('./tls-extractor');
const { buildObservationEnvelope } = require('../../../observatory/collection/observation-envelope');
const { OUTCOME } = require('../../../observatory/collection/observation-outcome');

const COLLECTOR = 'tls';
const COLLECTOR_VERSION = 'tls-extractor@1.0.0';
const COLLECTION_METHOD = 'TLS';

// endpoint_state ∈ RESPONSE_OBSERVED | TLS_ERROR | CONNECTION_ERROR. There is no
// OBSERVED_ABSENT for TLS (a host either negotiates TLS or you cannot tell).
function deriveCollectionOutcome(facts) {
  if (facts.endpoint_state === 'RESPONSE_OBSERVED') return OUTCOME.OBSERVED_PRESENT;
  if (facts.endpoint_state === 'TLS_ERROR') return OUTCOME.COLLECTION_ERROR;   // connected, handshake failed
  return OUTCOME.NOT_OBSERVED;                                                 // CONNECTION_ERROR / other
}

function buildTlsObservation(input) {
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

  return {
    domain,
    run_id: run.id,                 // existing collector-local column (NOT NULL) — reuse the canonical run id
    signal_version: 1,
    ...promotedScalars(facts),      // endpoint_state + promoted scalar columns (existing shape)
    evidence: facts,                // full raw evidence JSONB, verbatim (OC-3)
    ...envelope,
  };
}

const tlsAdapter = {
  signal: COLLECTOR,
  tableName: 'signal_tls_v1',
  programme: { key: 'national-tls', name: 'National TLS', kind: 'NATIONAL', signal: 'tls' },
  // collect is the existing extractor over a live TLS session — supplied by the
  // TLS run pipeline (a session is established, then extractTLSEvidence runs).
  collect: null,
  buildObservation: buildTlsObservation,
};

module.exports = { deriveCollectionOutcome, buildTlsObservation, tlsAdapter };
