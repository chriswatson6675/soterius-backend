'use strict';

// Canonical Observation envelope builder — the signal-agnostic half of every
// buildObservation(). Extracted in Sprint 8 so each signal's buildObservation
// reduces to: assemble the signal payload, derive the collection outcome, and
// call this. It removes the envelope boilerplate every collector would otherwise
// copy.
//
// This is the Canonical Observation Contract's Envelope (Sprint 4) in code. It
// carries ownership, collector identity, provenance, subject reference, and the
// collection outcome — never a score or judgement (P-2).

// buildObservationEnvelope(input) → the envelope fields for one Observation.
//   input = {
//     run,                                  // { id, programme_id } — the owning run
//     collector, collectorVersion, collectionMethod,   // provenance (P-7)
//     observedAt,                            // when evidence was gathered
//     collectionOutcome,                     // the mechanical four-state (signal-derived)
//     organisationId?, repositoryAuthorityRef?,        // nullable by contract (P-5/OC-6)
//   }
function buildObservationEnvelope(input) {
  const { run, collector, collectorVersion, collectionMethod, observedAt, collectionOutcome } = input;

  if (!run || !run.id) throw new Error('a Collection Run (with id) is required to own the observation');
  if (!run.programme_id) throw new Error('the Collection Run must reference its programme_id');
  if (!collector) throw new Error('collector identity is required');
  if (!collectionOutcome) throw new Error('collectionOutcome is required');

  return {
    collected_at: observedAt,                              // contract: observed_at
    collection_run_id: run.id,
    collection_programme_id: run.programme_id,
    collector,
    collector_version: collectorVersion,
    collection_method: collectionMethod,
    organisation_id: input.organisationId ?? null,          // nullable by contract (P-5)
    repository_authority_ref: input.repositoryAuthorityRef ?? null,
    collection_outcome: collectionOutcome,
  };
}

// makeObservationBuilder(config) → a signal's buildObservation(input) function.
//
// Collapses the identical buildObservation boilerplate every collector would
// otherwise copy (validate domain/facts → envelope → payload spread) into one
// factory. The ONLY signal-specific inputs are the collector identity constants,
// the signal's deriveCollectionOutcome, and any static payload fields (e.g.
// signal_version) that belong on that signal's rows.
//
//   config = {
//     collector, collectorVersion, collectionMethod,   // provenance constants
//     deriveCollectionOutcome(facts) -> outcome,        // the signal-specific bit
//     staticPayload?,                                   // e.g. { signal_version: 1 }
//   }
//
// The returned builder produces { domain, ...staticPayload, ...facts, ...envelope }
// — exactly the DNSSEC reference shape. `facts` (raw evidence + observed facts)
// is spread verbatim, never transformed (OC-3).
function makeObservationBuilder(config) {
  const { collector, collectorVersion, collectionMethod, deriveCollectionOutcome, staticPayload = {} } = config;
  if (!collector) throw new Error('makeObservationBuilder: collector is required');
  if (typeof deriveCollectionOutcome !== 'function') throw new Error('makeObservationBuilder: deriveCollectionOutcome must be a function');

  return function buildObservation(input) {
    const { domain, facts } = input;
    if (!domain) throw new Error('domain is required');
    if (!facts || typeof facts !== 'object') throw new Error('collector facts are required');

    const observedAt = input.observedAt ?? new Date().toISOString();
    const envelope = buildObservationEnvelope({
      run: input.run,
      collector,
      collectorVersion,
      collectionMethod,
      observedAt,
      collectionOutcome: deriveCollectionOutcome(facts),
      organisationId: input.organisationId ?? null,
      repositoryAuthorityRef: input.repositoryAuthorityRef ?? null,
    });

    return { domain, ...staticPayload, ...facts, ...envelope };
  };
}

module.exports = { buildObservationEnvelope, makeObservationBuilder };
