'use strict';

// DNS signal collection — OBS-102 (DNS Observation Integration).
//
// Runs ONE existing DNS-based signal's collection + facts persistence +
// quality-model scoring pathway for ONE domain, reusing exactly the same
// primitives the On-Demand Observation Pipeline uses
// (backend/observatory/on-demand/on-demand-observation.js's runOneSignal) —
// scoped to only the five DNS-based signals this work package covers. Never
// touches MTA-STS, security headers, security.txt, TLS, or certificate — the
// on-demand pipeline bundles all of those together, so this module composes
// the same underlying primitives narrowly instead of calling that pipeline
// wholesale.
//
// No collector is rewritten here. collectSpf/collectDkim/collectDmarc/
// collectDnssec/collectCaa, their *-observation.js adapters, the Collection
// Session engine, and the quality-model scoring functions are all reused
// completely unmodified.

const crypto = require('node:crypto');

const DNS_OBSERVATION_TYPES = ['spf', 'dkim', 'dmarc', 'dnssec', 'caa'];

function getClient() { return require('../../infra/database').getClient(); }

function defaultAdapters() {
  return require('../../collection/runs/national/run-national').nationalAdapters();
}

function defaultRunCollection(input, client) {
  return require('../collection/resilient-collection-session').runResilientCollectionSession({
    ...input, deps: { ...(input.deps || {}), client },
  });
}

async function defaultReadPersistedFacts({ tableName, domain, collectionRunId }, client) {
  const { data, error } = await client
    .from(tableName)
    .select('*')
    .eq('domain', domain)
    .eq('collection_run_id', collectionRunId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return { data, error };
}

/**
 * collectDnsSignal(domain, signal, deps) →
 *   { observed, scored, factsRow, qualityRow, error, reason? }
 *
 * `factsRow` is the persisted signal_facts_* row (Evidence) — the same row
 * shape scoreSpfQuality()/etc. and generate-trust-profile.js already read
 * elsewhere in this codebase. `qualityRow` is the persisted signal_quality_*
 * row, when scoring succeeded.
 *
 * A collector's own result distinguishing "successfully observed: absent"
 * from "collection failed" (Unknown ≠ Absent) is never second-guessed here —
 * `observed` reflects exactly what the Collection Session already decided;
 * this module adds no classification of its own on top of it.
 */
async function collectDnsSignal(domain, signal, deps = {}) {
  if (!DNS_OBSERVATION_TYPES.includes(signal)) {
    throw new Error(`collectDnsSignal: "${signal}" is not a supported DNS observation type (${DNS_OBSERVATION_TYPES.join(', ')})`);
  }

  const {
    adapters = defaultAdapters(),
    runCollection = defaultRunCollection,
    readPersistedFacts = defaultReadPersistedFacts,
    persistQuality = require('../quality/persist/on-demand-quality').persistOnDemandQuality,
    collectCaaAncestors = require('../on-demand/caa-ancestor-lookup').collectCaaAncestorPopulation,
    client = getClient(),
    now,
  } = deps;

  const timestamp = now ? now() : new Date().toISOString();
  const adapter = adapters[signal];
  const runLabel = `OBS102-${signal.toUpperCase()}-${domain}-${timestamp}`;

  let collectionRes;
  try {
    collectionRes = await runCollection({
      runLabel, domains: [domain], adapter, options: { resume: false, concurrency: 1 },
    }, client);
  } catch (err) {
    return { observed: false, scored: false, factsRow: null, qualityRow: null, error: err.message };
  }

  const obs = collectionRes.observations && collectionRes.observations[0];
  if (!obs || obs.error) {
    return {
      observed: false, scored: false, factsRow: null, qualityRow: null,
      error: obs && obs.error ? obs.error : 'no observation produced',
    };
  }

  // childError: the Collection Session engine persists a child table (e.g.
  // signal_facts_dkim_keys) as a best-effort step AFTER the parent Evidence
  // row is durably inserted — a child failure is recorded on the observation
  // record (rec.childError, resilient-collection-session.js) but deliberately
  // never fails the run, since the parent Evidence is already evidence of
  // record. OBS-102 must not silently discard that signal (found during the
  // 2026-07-16 supervised trial: two of five DKIM collections found real
  // selectors with zero corresponding signal_facts_dkim_keys rows) — surface
  // it so a caller can tell "fully observed" from "observed, but some
  // supplementary evidence did not persist," rather than reporting them
  // identically as `observed: true` with no further detail.
  const childError = obs.childError || null;

  // Read back the just-persisted Evidence row — never score from an
  // in-memory pre-persistence value (evidence-first, same discipline the
  // on-demand pipeline and every national batch loader already follow).
  const { data: factsRow, error: readErr } = await readPersistedFacts(
    { tableName: adapter.tableName, domain, collectionRunId: collectionRes.run.id }, client,
  );
  if (readErr || !factsRow) {
    return {
      observed: true, scored: false, factsRow: null, qualityRow: null,
      error: readErr ? readErr.message : 'observation row not found on read-back',
      childError,
    };
  }

  let population;
  if (signal === 'caa') {
    population = await collectCaaAncestors(domain, factsRow, {});
  }

  const qualityRes = await persistQuality({
    signal, facts: factsRow,
    runId: crypto.randomUUID(),
    runLabel: `OBS102-QUALITY-${signal.toUpperCase()}-${domain}-${timestamp}`,
    sourceRunId: collectionRes.run.id,
    population,
  }, { client });

  if (!qualityRes.ok) {
    return { observed: true, scored: false, factsRow, qualityRow: null, error: qualityRes.error, childError };
  }
  if (!qualityRes.persisted) {
    return { observed: true, scored: false, factsRow, qualityRow: null, error: null, reason: qualityRes.result.reason, childError };
  }
  return { observed: true, scored: true, factsRow, qualityRow: qualityRes.row, error: null, childError };
}

module.exports = { DNS_OBSERVATION_TYPES, collectDnsSignal };
