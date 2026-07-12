'use strict';

// Certificate canonical Observation adapter (Sprint 9 rollout). Same deviation as
// TLS: signal_certificate_v1 stores full evidence JSONB + promoted scalars.
// buildObservation reproduces that shape and adds the envelope. Certificate has a
// genuine OBSERVED_ABSENT (a handshake was observed but no certificate presented).

const { promotedScalars } = require('./certificate-extractor');
const { buildObservationEnvelope } = require('../../../observatory/collection/observation-envelope');
const { OUTCOME } = require('../../../observatory/collection/observation-outcome');

const COLLECTOR = 'certificate';
const COLLECTOR_VERSION = 'certificate-extractor@1.0.0';
const COLLECTION_METHOD = 'TLS';

// Two gates, mirroring certificate-quality.js: endpoint must be observed, then a
// certificate must have been presented.
function deriveCollectionOutcome(facts) {
  if (facts.endpoint_state !== 'RESPONSE_OBSERVED') {
    return facts.endpoint_state === 'TLS_ERROR' ? OUTCOME.COLLECTION_ERROR : OUTCOME.NOT_OBSERVED;
  }
  if (facts.certificate_present === 'CERTIFICATE_PRESENTED') return OUTCOME.OBSERVED_PRESENT;
  if (facts.certificate_present === 'NO_CERTIFICATE') return OUTCOME.OBSERVED_ABSENT;
  return OUTCOME.NOT_OBSERVED;   // HANDSHAKE_INCOMPLETE / null — observed the endpoint but not a clean cert answer
}

function buildCertificateObservation(input) {
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
    run_id: run.id,
    signal_version: 1,
    ...promotedScalars(facts),
    evidence: facts,
    ...envelope,
  };
}

const certificateAdapter = {
  signal: COLLECTOR,
  tableName: 'signal_certificate_v1',
  programme: { key: 'national-certificate', name: 'National Certificate', kind: 'NATIONAL', signal: 'certificate' },
  collect: null,   // extractor runs over a live TLS session, supplied by the certificate run pipeline
  buildObservation: buildCertificateObservation,
};

module.exports = { deriveCollectionOutcome, buildCertificateObservation, certificateAdapter };
