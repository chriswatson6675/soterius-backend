'use strict';

// DKIM canonical Observation adapter (Sprint 9 rollout). DKIM DEVIATES from the
// flat pattern in two ways, so its buildObservation is bespoke:
//
//   1. Two-table payload. The domain-level Observation lives in signal_facts_dkim;
//      the discovered keys are fanned out to signal_facts_dkim_keys (a child
//      table) by the existing DKIM persistence, which this sprint does not change.
//      The canonical Observation (envelope) belongs on the domain-level row, so
//      buildObservation strips `dkim_keys` (not a domain-row column). Child-key
//      persistence via the Collection Session is DKIM-specific remaining work
//      (see the Sprint 9 report) — the envelope rollout targets the domain-level
//      Observation.
//
//   2. dkim_present is two-state (true | null; never false — the selector
//      namespace is non-enumerable, so absence is unprovable). dkim_collection_status
//      = NOT_DETECTED means "all probes completed, no key found" — a probe-set-
//      BOUNDED non-detection. The four-state envelope has no fifth value, so this
//      maps to OBSERVED_ABSENT, with the bounded nuance preserved in the payload
//      field dkim_collection_status (which the QM reads, not the envelope outcome).

const { collectDkim } = require('./dkim-collector');
const { buildObservationEnvelope } = require('../../../observatory/collection/observation-envelope');
const { OUTCOME } = require('../../../observatory/collection/observation-outcome');

const COLLECTOR = 'dkim';
const COLLECTOR_VERSION = 'dkim-collector@1.0.0';
const COLLECTION_METHOD = 'DNS';

function deriveCollectionOutcome(facts) {
  if (facts.dkim_present === true) return OUTCOME.OBSERVED_PRESENT;
  const status = facts.dkim_collection_status;
  if (status === 'NOT_DETECTED') return OUTCOME.OBSERVED_ABSENT;   // probe-set-bounded (nuance in payload)
  if (status === 'DNS_TIMEOUT') return OUTCOME.NOT_OBSERVED;
  return OUTCOME.COLLECTION_ERROR;                                 // DNS_SERVFAIL / DNS_FAILURE
}

function buildDkimObservation(input) {
  const { domain, facts } = input;
  if (!domain) throw new Error('domain is required');
  if (!facts || typeof facts !== 'object') throw new Error('collector facts are required');

  // dkim_keys is child-table material, not a domain-row column — excluded from the
  // domain-level Observation. The key evidence itself is preserved by DKIM's
  // existing key-table persistence (unchanged this sprint).
  const { dkim_keys, ...domainFacts } = facts;
  void dkim_keys;

  const observedAt = input.observedAt ?? new Date().toISOString();
  const envelope = buildObservationEnvelope({
    run: input.run,
    collector: COLLECTOR,
    collectorVersion: COLLECTOR_VERSION,
    collectionMethod: COLLECTION_METHOD,
    observedAt,
    collectionOutcome: deriveCollectionOutcome(facts),
    organisationId: input.organisationId ?? null,
    repositoryAuthorityRef: input.repositoryAuthorityRef ?? null,
  });

  return { domain, signal_version: 1, ...domainFacts, ...envelope };
}

// Child-row persistence for the two-table DKIM design. Called by the Collection
// Session AFTER the domain-level Observation is written, fanning the discovered
// keys out to signal_facts_dkim_keys — the same shape the legacy path wrote, so
// no key evidence is lost when DKIM runs through the canonical session.
async function persistDkimKeys({ domain, facts, run, observedAt, client }) {
  const keys = Array.isArray(facts.dkim_keys) ? facts.dkim_keys : [];
  if (keys.length === 0) return;
  const rows = keys.map((k) => ({
    dkim_run_id: run.id,
    domain,
    collected_at: observedAt,
    selector: k.selector,
    raw_record: k.raw_record,
    parse_success: k.parse_success,
    version: k.version,
    key_type: k.key_type,
    key_bits: k.key_bits,
    public_key_present: k.public_key_present,
    hash_algorithms: k.hash_algorithms,
    service_type: k.service_type,
    flags: k.flags,
    syntax_errors: k.syntax_errors,
  }));
  const { error } = await client.from('signal_facts_dkim_keys').insert(rows);
  if (error) throw new Error(error.message);
}

const dkimAdapter = {
  signal: COLLECTOR,
  tableName: 'signal_facts_dkim',
  programme: { key: 'national-dkim', name: 'National DKIM', kind: 'NATIONAL', signal: 'dkim' },
  collect: collectDkim,
  buildObservation: buildDkimObservation,
  persistChildren: persistDkimKeys,
};

module.exports = { deriveCollectionOutcome, buildDkimObservation, persistDkimKeys, dkimAdapter };
