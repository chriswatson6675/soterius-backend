'use strict';

// Generic Collection Session framework — the standard orchestration path for
// every Observatory collector under the canonical Observation model.
//
// Sprint 8 of the ADR-SYS-009 implementation programme. Extracted verbatim from
// the DNSSEC reference (Sprint 7) with all DNSSEC-specifics removed. This module
// contains NO signal-specific logic: it opens a Collection Run, invokes the
// collector, builds and persists one canonical Observation per domain, tracks
// successes/failures, and completes the run — for ANY signal.
//
// Everything signal-specific is supplied by a SIGNAL ADAPTER:
//   adapter = {
//     tableName,                         // where Observations for this signal live
//     programme: { key, name, kind?, signal? },  // the standing programme to own runs
//     collect(domain) -> facts,           // the collector (signal-specific)
//     buildObservation({ domain, facts, run, observedAt })  -> row  // envelope+payload
//   }
// The adapter's collect / buildObservation (and the deriveCollectionOutcome that
// buildObservation calls) are the ONLY signal-specific code. This framework never
// imports a collector, a Quality Model, or a signal module.

const registry = require('./registry');
const emitters = require('../events/emitters');
const logger = require('../../infra/utils/logger');

function getClient() {
  return require('../../infra/database').getClient();
}

// The canonical Organisation Resolution Service (Sprint 10). Lazily required so
// pure/injected tests never load the Repository Authority dataset. Only a
// RESOLVED outcome populates organisation_id; every other outcome (NOT_FOUND /
// AMBIGUOUS / INVALID) leaves it NULL, so an Observation is never assigned to the
// wrong Organisation.
function defaultResolveOrganisation(domain) {
  return require('../../organisation/resolve').resolveOrganisationByDomain(domain);
}

// runCollectionSession({ runLabel, domains, adapter, deps }) — execute one
// Collection Run over a domain list, producing one Observation per domain, all
// owned by that run. Returns { programme, run, observations, counts }.
//
// deps (all injectable for tests): { upsertProgramme, openRun, transitionRun,
//   collect, buildObservation, client, now }. When omitted, collect and
//   buildObservation come from the adapter and the persistence collaborators from
//   the registry / shared Supabase client.
async function runCollectionSession({ runLabel, domains, adapter, deps = {} }) {
  if (!adapter) throw new Error('a signal adapter is required');
  if (!adapter.tableName) throw new Error('adapter.tableName is required');
  if (!adapter.programme || !adapter.programme.key) throw new Error('adapter.programme.key is required');
  if (!runLabel) throw new Error('runLabel is required');
  if (!Array.isArray(domains) || domains.length === 0) throw new Error('domains must be a non-empty array');

  const {
    upsertProgramme = registry.upsertProgramme,
    openRun = registry.openRun,
    transitionRun = registry.transitionRun,
    collect = adapter.collect,
    buildObservation = adapter.buildObservation,
    resolveOrganisation = defaultResolveOrganisation,
    // Optional signal-specific hook to persist child rows (e.g. DKIM's
    // signal_facts_dkim_keys) after the parent Observation is written. Receives
    // { observationId, domain, facts, run, client }. A child failure is recorded
    // on the observation but never fails the parent (which is already persisted).
    persistChildren = adapter.persistChildren,
    // Parallel domain processing for national-scale runs. Default 1 preserves the
    // prior sequential behaviour exactly.
    concurrency = 1,
    client = getClient(),
    now,
  } = deps;

  if (typeof collect !== 'function') throw new Error('adapter.collect (or deps.collect) must be a function');
  if (typeof buildObservation !== 'function') throw new Error('adapter.buildObservation (or deps.buildObservation) must be a function');

  const timestamp = () => (now ? now() : new Date().toISOString());

  // 1 ── Collection Programme (idempotent — created once, reused by every run).
  const p = adapter.programme;
  const progRes = await upsertProgramme(
    { key: p.key, name: p.name, kind: p.kind ?? 'NATIONAL', signal: p.signal ?? null },
    client,
  );
  if (!progRes.success) throw new Error(`programme upsert failed: ${progRes.error}`);
  const programme = progRes.programme;

  // 2 ── Collection Run, owned by the programme; its identity owns every Observation.
  const runRes = await openRun(
    { programmeId: programme.id, runLabel, metadata: { domain_count: domains.length } },
    client,
  );
  if (!runRes.success) throw new Error(`run open failed: ${runRes.error}`);
  const run = runRes.run;

  // 3 ── One Observation per domain, all owned by this run. A single domain's
  //      collection/build/persist failure is recorded against that domain and the
  //      run continues (a failed domain is a failed Observation, not a failed Run).
  const observations = new Array(domains.length);
  let persisted = 0;
  let failed = 0;
  let nextIndex = 0;

  async function processDomain(domain, i) {
    try {
      const facts = await collect(domain);

      // Resolve the Organisation. Only a deterministic RESOLVED outcome sets
      // organisation_id; anything else leaves it NULL (never a guess). A resolver
      // failure never blocks collection — the Observation persists unlinked.
      let organisationId = null;
      let repositoryAuthorityRef = null;
      try {
        const res = resolveOrganisation(domain);
        if (res && res.outcome === 'RESOLVED') {
          organisationId = res.organisationId;
          repositoryAuthorityRef = `authority@${res.provenance?.authorityVersion ?? 'unknown'}`;
        }
      } catch { /* resolution error → leave unlinked, continue collecting */ }

      const observedAt = timestamp();
      const row = buildObservation({ domain, facts, run, observedAt, organisationId, repositoryAuthorityRef });
      const { data, error } = await client
        .from(adapter.tableName)
        .insert([row])
        .select('id')
        .single();
      if (error) {
        failed++;
        observations[i] = { domain, error: error.message };
        return;
      }
      persisted++;
      observations[i] = { domain, id: data.id };

      // Constitutional Event (OBS-CONST-001 §4) — mark the completion of
      // Observation persistence. Best-effort and non-blocking: the Observation
      // is already durably inserted, which is the evidence of record — Evidence
      // Preservation outranks Event bookkeeping, so a failure here is logged and
      // swallowed, never thrown. No score, band, or Quality Model output is
      // attached (interpretation runs downstream, separately, never here).
      // organisationId may be null (Unknown ≠ Absent): the Event still records
      // that persistence happened even when the Organisation is not yet known.
      const observationId = data?.id ?? null; // captured once, outside the try — never re-derived inside a catch
      try {
        const evRes = await emitters.emitObservationRecorded({
          organisationId,
          collectionRunId: run.id,
          occurredAt: observedAt,
          repositoryAuthorityVersion: repositoryAuthorityRef,
          metadata: { domain, observationId, signal: p.signal ?? p.key },
        }, client);
        if (!evRes.ok) logger.warn(`Event emission failed for ${domain} (observation ${observationId} still persisted): ${evRes.error}`);
      } catch (evErr) {
        logger.warn(`Event emission threw for ${domain} (observation ${observationId} still persisted): ${evErr.message}`);
      }

      // Child rows (e.g. DKIM keys) — the parent is already persisted, so a child
      // failure is recorded but never counted as a failed observation.
      if (persistChildren) {
        try {
          await persistChildren({ observationId: data.id, domain, facts, run, observedAt, client });
        } catch (childErr) {
          observations[i].childError = childErr.message;
        }
      }
    } catch (err) {
      failed++;
      observations[i] = { domain, error: err.message };
    }
  }

  // Concurrency pool — `concurrency` workers pull from a shared index. Default 1
  // is exactly the prior sequential loop; higher values parallelise national runs.
  const workerCount = Math.max(1, Math.min(concurrency, domains.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < domains.length) {
      const i = nextIndex++;
      await processDomain(domains[i], i);
    }
  }));

  // 4 ── Close the run. COMPLETED because it executed end to end; per-domain
  //      failures live on the individual Observations, not on the run.
  const termRes = await transitionRun(
    run.id, 'RUNNING', 'COMPLETED',
    { metadata: { domain_count: domains.length, persisted, failed } },
    client,
  );

  return {
    programme,
    run: termRes.success ? termRes.run : run,
    observations,
    counts: { total: domains.length, persisted, failed },
  };
}

module.exports = { runCollectionSession };
