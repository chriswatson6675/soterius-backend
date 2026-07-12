'use strict';

// security.txt canonical Observation adapter (Sprint 9 rollout). DEVIATES: the
// collector emits `signal_id` (no column) and omits the NOT NULL `run_id`;
// signal_securitytxt_v1 stores JSONB fetch/parse blocks. buildObservation maps
// only real columns and supplies run_id from the canonical run.

const { collectSecurityTxt } = require('./securitytxt-collector');
const { buildObservationEnvelope } = require('../../../observatory/collection/observation-envelope');
const { OUTCOME } = require('../../../observatory/collection/observation-outcome');

const COLLECTOR = 'securitytxt';
const COLLECTOR_VERSION = 'securitytxt-collector@1.0.0';
const COLLECTION_METHOD = 'HTTPS';

// file_state: PRESENT_* → present; ABSENT → confirmed absent; INDETERMINATE →
// a blocking fetch error (timeout/connection/server) prevented a determination.
function deriveCollectionOutcome(facts) {
  if (facts.file_state === 'INDETERMINATE') return OUTCOME.NOT_OBSERVED;
  if (facts.file_state === 'ABSENT') return OUTCOME.OBSERVED_ABSENT;
  return OUTCOME.OBSERVED_PRESENT;   // PRESENT_CANONICAL | PRESENT_LEGACY_ONLY | PRESENT_BOTH
}

function buildSecurityTxtObservation(input) {
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

  // Real signal_securitytxt_v1 columns only (drop the collector's non-column signal_id).
  return {
    domain,
    run_id: run.id,
    signal_version: facts.signal_version,
    file_state: facts.file_state,
    canonical_fetch: facts.canonical_fetch,
    legacy_fetch: facts.legacy_fetch,
    canonical_parse: facts.canonical_parse,
    legacy_parse: facts.legacy_parse,
    ...envelope,
  };
}

const securityTxtAdapter = {
  signal: COLLECTOR,
  tableName: 'signal_securitytxt_v1',
  programme: { key: 'national-securitytxt', name: 'National security.txt', kind: 'NATIONAL', signal: 'securitytxt' },
  collect: (domain) => collectSecurityTxt(domain, COLLECTOR_VERSION),
  buildObservation: buildSecurityTxtObservation,
};

module.exports = { deriveCollectionOutcome, buildSecurityTxtObservation, securityTxtAdapter };
