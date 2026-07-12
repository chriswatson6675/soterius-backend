'use strict';

// DNSSEC Observation persistence — the Observatory's REFERENCE implementation of
// the Canonical Observation Contract (Sprint 4) on a single collector.
//
// Sprint 6 of the ADR-SYS-009 implementation programme. This module wraps the
// DNSSEC collector's raw facts (dnssec-collector.js — UNCHANGED) into a full
// Observation (envelope + payload) and persists it to signal_facts_dnssec
// (migration 039 envelope columns + migration 011 payload columns).
//
// It writes evidence only. It computes NO score, band, or judgement (P-2): the
// one derived field it produces, collection_outcome, is a mechanical collection
// fact (did we observe, and was DNSSEC material present) — never a signed-ness
// interpretation, which is the Quality Model's job and lives in
// signal_quality_dnssec.
//
// The collector's collection logic is not touched; only persistence is added.
// Persistence takes an injectable client for testability (infra/database pattern).

const { SIGNAL_ID, SIGNAL_VERSION } = require('./dnssec-collector');
const { buildObservationEnvelope } = require('../../../observatory/collection/observation-envelope');
const logger = require('../../../infra/utils/logger');

// Exact collector code version recorded in each Observation's provenance
// (envelope.collector_version). Distinct from SIGNAL_VERSION (the integer signal
// schema version already stored as signal_version): this identifies the code that
// produced the observation, per the contract's provenance requirement (P-7).
const COLLECTOR_VERSION = 'dnssec-collector@1.0.0';
const DEFAULT_COLLECTION_METHOD = 'DoH:cloudflare-dns.com';

const OUTCOME = Object.freeze({
  OBSERVED_PRESENT: 'OBSERVED_PRESENT',
  OBSERVED_ABSENT:  'OBSERVED_ABSENT',
  NOT_OBSERVED:     'NOT_OBSERVED',
  COLLECTION_ERROR: 'COLLECTION_ERROR',
});

// deriveCollectionOutcome(facts) — the envelope-level, four-state collection
// outcome, computed mechanically from the two three-state presence fields.
//
// DNSSEC has two independent collection points (DS, DNSKEY). The Quality Model
// scores a domain only when BOTH axes were confirmed observed (never null) —
// so the envelope mirrors that: a clean PRESENT/ABSENT is emitted ONLY when both
// axes resolved. If EITHER axis failed to resolve, the observation is incomplete
// and is reported as NOT_OBSERVED (transient/timeout) or COLLECTION_ERROR
// (resolver failure) — never silently as a confirmed absence (P-5 / OC-4).
//
// PRESENT here means "DNSSEC material was observed" (a DS or DNSKEY record exists)
// — a mechanical record-presence fact, NOT a claim that DNSSEC is valid/anchored
// (that judgement is the Quality Model's ANCHORED/ISLAND/UNSIGNED).
function deriveCollectionOutcome(facts) {
  const dsUnknown = facts.dns_ds_present === null || facts.dns_ds_present === undefined;
  const dkUnknown = facts.dns_dnskey_present === null || facts.dns_dnskey_present === undefined;

  if (dsUnknown || dkUnknown) {
    const errors = [facts.ds_collection_error, facts.dnskey_collection_error].filter(Boolean);
    // Timeout means "we could not determine" (NOT_OBSERVED); it takes precedence
    // over a hard resolver failure, mirroring the Sprint-3 aggregate precedence.
    if (errors.includes('DNS_TIMEOUT')) return OUTCOME.NOT_OBSERVED;
    return OUTCOME.COLLECTION_ERROR;
  }

  const materialPresent = facts.dns_ds_present === true || facts.dns_dnskey_present === true;
  return materialPresent ? OUTCOME.OBSERVED_PRESENT : OUTCOME.OBSERVED_ABSENT;
}

// buildDnssecObservation(input) — assemble a complete Observation row (envelope +
// payload) from collector facts and a Collection Run context. Pure and
// deterministic; performs no I/O.
//
//   input = {
//     domain, facts,                     // collector output (dnssec-collector.js)
//     run,                               // { id, programme_id } from the registry
//     observedAt?,                       // when the evidence was gathered
//     organisationId?, repositoryAuthorityRef?,   // nullable by contract
//     collectionMethod?,
//   }
function buildDnssecObservation(input) {
  const { domain, facts } = input;
  if (!domain) throw new Error('domain is required');
  if (!facts || typeof facts !== 'object') throw new Error('collector facts are required');

  const observedAt = input.observedAt ?? new Date().toISOString();

  // Signal-agnostic envelope (shared helper; validates the run ownership).
  const envelope = buildObservationEnvelope({
    run: input.run,
    collector: SIGNAL_ID,                      // 'dnssec'
    collectorVersion: COLLECTOR_VERSION,
    collectionMethod: input.collectionMethod ?? DEFAULT_COLLECTION_METHOD,
    observedAt,
    collectionOutcome: deriveCollectionOutcome(facts),   // the signal-specific bit
    organisationId: input.organisationId ?? null,
    repositoryAuthorityRef: input.repositoryAuthorityRef ?? null,
  });

  return {
    // ── Payload (from migration 011; collector-produced, verbatim) ────────────
    domain,
    signal_version: SIGNAL_VERSION,
    ...facts,                                 // raw evidence + observed facts, unchanged
    // ── Envelope (from migration 039; shared helper) ──────────────────────────
    ...envelope,
  };
}

function getClient() {
  return require('../../../infra/database').getClient();
}

// persistDnssecObservation(input, client) — build and insert one Observation.
// Returns { success, id } | { success:false, error }. Never throws.
async function persistDnssecObservation(input, client = getClient()) {
  try {
    const row = buildDnssecObservation(input);
    const { data, error } = await client
      .from('signal_facts_dnssec')
      .insert([row])
      .select('id')
      .single();
    if (error) {
      logger.error('[dnssec-observation] persist failed:', { message: error.message });
      return { success: false, error: error.message };
    }
    return { success: true, id: data.id };
  } catch (err) {
    logger.error('[dnssec-observation] persist threw:', { message: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = {
  buildDnssecObservation,
  deriveCollectionOutcome,
  persistDnssecObservation,
  OUTCOME,
  COLLECTOR_VERSION,
  DEFAULT_COLLECTION_METHOD,
};
