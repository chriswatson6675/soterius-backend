'use strict';

// DMARC canonical Observation adapter (Sprint 9 rollout). Flat signal_facts_dmarc
// table — clean factory buildObservation; only deriveCollectionOutcome is
// signal-specific.

const { collectDmarc } = require('./dmarc-collector');
const { makeObservationBuilder } = require('../../../observatory/collection/observation-envelope');
const { dnsThreeStateOutcome } = require('../../../observatory/collection/observation-outcome');

const COLLECTOR = 'dmarc';
const COLLECTOR_VERSION = 'dmarc-collector@1.0.0';
const COLLECTION_METHOD = 'DNS';

// dmarc_present three-state + dmarc_collection_error (set only when present==null),
// so the standard DNS mapping matches the QM's incomplete/absent gates exactly.
function deriveCollectionOutcome(facts) {
  return dnsThreeStateOutcome(facts.dmarc_present, facts.dmarc_collection_error);
}

const buildDmarcObservation = makeObservationBuilder({
  collector: COLLECTOR,
  collectorVersion: COLLECTOR_VERSION,
  collectionMethod: COLLECTION_METHOD,
  deriveCollectionOutcome,
  staticPayload: { signal_version: 1 },
});

const dmarcAdapter = {
  signal: COLLECTOR,
  tableName: 'signal_facts_dmarc',
  programme: { key: 'national-dmarc', name: 'National DMARC', kind: 'NATIONAL', signal: 'dmarc' },
  collect: collectDmarc,
  buildObservation: buildDmarcObservation,
};

module.exports = { deriveCollectionOutcome, buildDmarcObservation, dmarcAdapter };
