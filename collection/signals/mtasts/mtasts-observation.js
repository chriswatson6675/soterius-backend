'use strict';

// MTA-STS canonical Observation adapter (Sprint 9 rollout). Flat
// signal_facts_mtasts table (clean factory buildObservation), but a TWO-PART
// collection (DNS STS record + HTTPS policy fetch), so deriveCollectionOutcome is
// signal-specific and mirrors the QM's two incomplete gates.

const { collectMtaSts } = require('./mtasts-collector');
const { makeObservationBuilder } = require('../../../observatory/collection/observation-envelope');
const { OUTCOME } = require('../../../observatory/collection/observation-outcome');

const COLLECTOR = 'mtasts';
const COLLECTOR_VERSION = 'mtasts-collector@1.0.0';
const COLLECTION_METHOD = 'DNS+HTTPS';

// Two layers, evaluated in the QM's order:
//   DNS layer first: dns_sts_present null → not observed; false → absent (no STS).
//   Then policy layer (only when DNS record present): policy_present null → the
//   policy fetch failed, so the observation is incomplete. STS material present +
//   policy observed (present or unusable) → PRESENT (the unusable nuance is a
//   payload/QM detail, not an envelope absence).
function deriveCollectionOutcome(facts) {
  if (facts.dns_sts_present == null) {
    return facts.dns_collection_error === 'DNS_TIMEOUT' ? OUTCOME.NOT_OBSERVED : OUTCOME.COLLECTION_ERROR;
  }
  if (facts.dns_sts_present === false) return OUTCOME.OBSERVED_ABSENT;
  // DNS STS record present — the policy layer must also have been observed.
  if (facts.policy_present == null) {
    return facts.policy_fetch_error === 'CONNECTION_TIMEOUT' ? OUTCOME.NOT_OBSERVED : OUTCOME.COLLECTION_ERROR;
  }
  return OUTCOME.OBSERVED_PRESENT;
}

const buildMtaStsObservation = makeObservationBuilder({
  collector: COLLECTOR,
  collectorVersion: COLLECTOR_VERSION,
  collectionMethod: COLLECTION_METHOD,
  deriveCollectionOutcome,
  staticPayload: { signal_version: 1 },
});

const mtastsAdapter = {
  signal: COLLECTOR,
  tableName: 'signal_facts_mtasts',
  programme: { key: 'national-mtasts', name: 'National MTA-STS', kind: 'NATIONAL', signal: 'mtasts' },
  collect: collectMtaSts,
  buildObservation: buildMtaStsObservation,
};

module.exports = { deriveCollectionOutcome, buildMtaStsObservation, mtastsAdapter };
