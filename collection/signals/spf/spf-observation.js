'use strict';

// SPF canonical Observation adapter (Sprint 9 rollout). Flat signal_facts_spf
// table — collector output keys match columns, so buildObservation is the generic
// factory. The only signal-specific code is deriveCollectionOutcome.

const { collectSpf } = require('./spf-collector');
const { makeObservationBuilder } = require('../../../observatory/collection/observation-envelope');
const { dnsThreeStateOutcome } = require('../../../observatory/collection/observation-outcome');

const COLLECTOR = 'spf';
const COLLECTOR_VERSION = 'spf-collector@1.0.0';
const COLLECTION_METHOD = 'DNS';

// spf_present three-state + spf_collection_error — the standard DNS mapping.
function deriveCollectionOutcome(facts) {
  return dnsThreeStateOutcome(facts.spf_present, facts.spf_collection_error);
}

const buildSpfObservation = makeObservationBuilder({
  collector: COLLECTOR,
  collectorVersion: COLLECTOR_VERSION,
  collectionMethod: COLLECTION_METHOD,
  deriveCollectionOutcome,
  staticPayload: { signal_version: 1 },
});

const spfAdapter = {
  signal: COLLECTOR,
  tableName: 'signal_facts_spf',
  programme: { key: 'national-spf', name: 'National SPF', kind: 'NATIONAL', signal: 'spf' },
  collect: collectSpf,
  buildObservation: buildSpfObservation,
};

module.exports = { deriveCollectionOutcome, buildSpfObservation, spfAdapter };
