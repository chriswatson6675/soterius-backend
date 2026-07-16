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
//
// DEFECT FIX (found during the OBS-102 supervised production trial, 2026-07-16):
// signal_facts_dkim_keys.dkim_run_id is a FOREIGN KEY to signal_facts_dkim(id) —
// the PARENT OBSERVATION ROW's own id — despite its name. This function
// previously set it to `run.id` (the collection_runs row's id, the same `run`
// buildObservation uses), which is a different id entirely and violates that
// FK on every insert. The caller has always passed the correct id as
// `observationId` (both collection-session.js and resilient-collection-
// session.js call `persistChildren({ observationId: data.id, ... })`) — it was
// simply never read. Confirmed via the live trial: 2 of 5 domains discovered
// real DKIM selectors/keys and zero rows persisted, with the failure silently
// caught and recorded only as an unsurfaced `childError` on the observation
// record. This affects every caller of this shared function identically
// (the on-demand pipeline and any national DKIM batch run through either
// Collection Session), not anything specific to one caller.
//
// Also hardened per the same trial's findings:
//  - Unknown != Absent: zero discovered keys is a clean, non-error outcome.
//  - Idempotent retry: an already-persisted selector for the same parent row
//    is skipped, never duplicated, so retrying the same collection result is
//    safe.
//  - Per-row insertion (not one bulk statement): one malformed key no longer
//    sacrifices every other valid key found for the same domain — a partial
//    failure persists what it safely can and still throws (so the caller's
//    childError visibly reflects "incomplete," never silently "complete").
async function persistDkimKeys({ observationId, domain, facts, run, observedAt, client }) {
  void run; // no longer used — see the defect-fix note above for why
  const keys = Array.isArray(facts.dkim_keys) ? facts.dkim_keys : [];
  const result = { attempted: keys.length, persisted: 0, skipped: 0, failed: 0, errors: [] };
  if (keys.length === 0) return result;

  if (!observationId) {
    // Never guess or fall back to an unrelated id (e.g. the collection run's) —
    // that is exactly the defect being fixed here.
    throw new Error('persistDkimKeys: observationId (the parent signal_facts_dkim row id) is required');
  }

  // Idempotent retry: skip any selector already persisted against this exact
  // parent row, so re-running the same collection result never duplicates rows.
  const { data: existingRows, error: existingErr } = await client
    .from('signal_facts_dkim_keys')
    .select('selector')
    .eq('dkim_run_id', observationId);
  if (existingErr) throw new Error(`persistDkimKeys: could not check existing keys: ${existingErr.message}`);
  const alreadyPersisted = new Set((existingRows || []).map((r) => r.selector));

  for (const k of keys) {
    if (alreadyPersisted.has(k.selector)) { result.skipped += 1; continue; }
    const row = {
      dkim_run_id: observationId,
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
    };
    // eslint-disable-next-line no-await-in-loop -- per-row by design, see header
    const { error } = await client.from('signal_facts_dkim_keys').insert(row);
    if (error) {
      result.failed += 1;
      result.errors.push(`${k.selector}: ${error.message}`);
    } else {
      result.persisted += 1;
    }
  }

  if (result.failed > 0) {
    const scope = (result.persisted > 0 || result.skipped > 0) ? 'partial' : 'complete';
    throw new Error(
      `persistDkimKeys: ${scope} failure — ${result.persisted} persisted, ${result.skipped} skipped (already present), ${result.failed} failed: ${result.errors.join('; ')}`,
    );
  }

  return result;
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
