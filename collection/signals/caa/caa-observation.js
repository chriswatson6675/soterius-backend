'use strict';

// CAA canonical Observation adapter (Sprint 9 rollout). Flat signal_facts_caa
// table — clean factory buildObservation; only deriveCollectionOutcome is
// signal-specific. (CAA tree-climb inheritance is a Quality-Model concern; the
// collector observes the apex only, so the envelope outcome is the apex presence.)

const { collectCaa } = require('./caa-collector');
const { makeObservationBuilder } = require('../../../observatory/collection/observation-envelope');
const { dnsThreeStateOutcome } = require('../../../observatory/collection/observation-outcome');

const COLLECTOR = 'caa';
const COLLECTOR_VERSION = 'caa-collector@1.0.0';
const COLLECTION_METHOD = 'DNS';

// dns_caa_present three-state + caa_collection_error — standard DNS mapping.
function deriveCollectionOutcome(facts) {
  return dnsThreeStateOutcome(facts.dns_caa_present, facts.caa_collection_error);
}

const buildCaaObservation = makeObservationBuilder({
  collector: COLLECTOR,
  collectorVersion: COLLECTOR_VERSION,
  collectionMethod: COLLECTION_METHOD,
  deriveCollectionOutcome,
  staticPayload: { signal_version: 1 },
});

const caaAdapter = {
  signal: COLLECTOR,
  tableName: 'signal_facts_caa',
  programme: { key: 'national-caa', name: 'National CAA', kind: 'NATIONAL', signal: 'caa' },
  collect: collectCaa,
  buildObservation: buildCaaObservation,
};

module.exports = { deriveCollectionOutcome, buildCaaObservation, caaAdapter };
