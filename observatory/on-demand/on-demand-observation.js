'use strict';

// on-demand-observation.js — the On-Demand Observation Pipeline orchestrator
// (ENG-007 §3.1, Phase 1).
//
// Given ONE domain, sequences: identity resolution -> per-signal
// collection+persistence -> per-signal quality scoring+persistence ->
// Observation Session lifecycle. ORCHESTRATION ONLY — coordinates existing,
// unmodified components; implements no collection, resolution, or scoring
// logic of its own (mirrors the discipline already stated by
// backend/acquisition/candidate-processor.js's own header).
//
// Reused, unmodified: resolveOrganisationByDomain (identity),
// runResilientCollectionSession + nationalAdapters (per-signal collection,
// 8 of 10 signals), runNationalTlsCertificate (the ADR-COL-003 shared
// TLS/Certificate dual-write), createSession/transition (Observation
// Session lifecycle). Reused from this same Phase 1 changeset:
// persistOnDemandQuality, collectCaaAncestorPopulation.
//
// NO Repository Authority write occurs anywhere in this module, under any
// resolution outcome — resolveOrganisationByDomain is read-only, and no
// other function this module calls ever writes to Repository Authority
// (OBS-CONST-001 §5: "Collectors never modify Repository Authority").
// Trust derivation for an unresolved domain proceeds unaffected: Observation
// and quality persistence are domain-keyed (verified: no signal_quality_*
// table has an organisation_id column), so a NOT_FOUND/AMBIGUOUS resolution
// outcome changes only which Organisation a caller can later resolve the
// results to — never whether the domain is observed or scored.

const crypto = require('node:crypto');

function getClient() { return require('../../infra/database').getClient(); }

function defaultResolveOrganisation(domain) {
  return require('../../organisation/resolve').resolveOrganisationByDomain(domain);
}

function defaultRunCollection(input, client) {
  return require('../collection/resilient-collection-session').runResilientCollectionSession({
    ...input, deps: { ...(input.deps || {}), client },
  });
}

function defaultRunTlsCertificate(input, client) {
  return require('../../collection/runs/national/run-national').runNationalTlsCertificate({
    ...input, deps: { ...(input.deps || {}), client },
  });
}

function defaultAdapters() {
  return require('../../collection/runs/national/run-national').nationalAdapters();
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

// The 8 signals collected via the generic Collection Session engine (7
// single-domain-pure signals + CAA, which additionally needs the bounded
// ancestor lookup after its own Observation is persisted). TLS and
// Certificate are handled separately (one shared handshake, ADR-COL-003).
const RESILIENT_SESSION_SIGNALS = ['spf', 'dmarc', 'dnssec', 'mtasts', 'dkim', 'securityheaders', 'securitytxt', 'caa'];

/**
 * Run the On-Demand Observation Pipeline for one domain.
 *
 * @param {string} domain
 * @param {Object} [deps] - all injectable for tests; see module header for
 *   what each defaults to when omitted.
 * @returns {Promise<
 *   {ok: true, sessionId: string, organisationId: string|null, resolutionOutcome: string, signals: Array<Object>} |
 *   {ok: false, error: string, sessionId?: string}
 * >}
 */
async function runOnDemandObservation(domain, deps = {}) {
  const {
    resolveOrganisation = defaultResolveOrganisation,
    createSession,
    transitionSession,
    runCollection = defaultRunCollection,
    runTlsCertificate = defaultRunTlsCertificate,
    persistQuality,
    collectCaaAncestors,
    readPersistedFacts = defaultReadPersistedFacts,
    adapters = defaultAdapters(),
    client = getClient(),
    now,
    requestedBy = null,
  } = deps;

  // Deferred requires (not at module top) so pure orchestration logic can be
  // unit-tested without loading the Observation Session DB module or the
  // quality/CAA modules unless a test actually exercises the default path.
  const sessionModule = require('../session/observation-session');
  const create = createSession || sessionModule.createSession;
  const transition = transitionSession || sessionModule.transition;
  const persist = persistQuality || require('../quality/persist/on-demand-quality').persistOnDemandQuality;
  const collectAncestors = collectCaaAncestors || require('./caa-ancestor-lookup').collectCaaAncestorPopulation;

  const timestamp = () => (now ? now() : new Date().toISOString());
  const startedAt = timestamp();

  // 1 — Resolve identity. Read-only; informational for the session record.
  // Each signal's own collection independently performs the SAME resolution
  // for its own Observation's organisation_id — this is not overridden here,
  // never duplicated as a second resolution mechanism, just called twice
  // against the one deterministic function (harmless; not a write).
  let resolution;
  try {
    resolution = resolveOrganisation(domain);
  } catch (err) {
    resolution = { outcome: 'NOT_FOUND', organisationId: null, provenance: { reason: 'RESOLUTION_ERROR', detail: err.message } };
  }
  const organisationId = resolution.outcome === 'RESOLVED' ? resolution.organisationId : null;

  // 2 — Open the session, already running (a synchronous on-demand scan).
  const sessionRes = await create({
    trigger: 'on-demand',
    status: 'running',
    scope: { domain, requestedBy },
    metadata: { resolutionOutcome: resolution.outcome, organisationId },
  }, client);
  if (!sessionRes.ok) return { ok: false, error: `session creation failed: ${sessionRes.error}` };
  const session = sessionRes.session;

  // 3 — Collect + score each signal. A signal's own failure is recorded on
  // its own result entry and never aborts the others (mirrors collect()'s
  // Promise.allSettled-style isolation already used by the legacy scanner
  // and by every Collection Session in this repository).
  async function runOneSignal(signal) {
    const adapter = adapters[signal];
    const runLabel = `ONDEMAND-${signal.toUpperCase()}-${domain}-${startedAt}`;

    let collectionRes;
    try {
      collectionRes = await runCollection({
        runLabel, domains: [domain], adapter, options: { resume: false, concurrency: 1 },
      }, client);
    } catch (err) {
      return { signal, observed: false, scored: false, error: err.message };
    }

    const obs = collectionRes.observations && collectionRes.observations[0];
    if (!obs || obs.error) {
      return {
        signal, observed: false, scored: false,
        error: obs && obs.error ? obs.error : 'no observation produced',
        collectionState: collectionRes.summary ? collectionRes.summary.state : null,
      };
    }

    // Read back the just-persisted Observation row — never score from an
    // in-memory pre-persistence value (evidence-first: the same discipline
    // every nob-*/load.js batch loader already follows).
    const { data: factsRow, error: readErr } = await readPersistedFacts(
      { tableName: adapter.tableName, domain, collectionRunId: collectionRes.run.id }, client,
    );
    if (readErr || !factsRow) {
      return { signal, observed: true, scored: false, error: readErr ? readErr.message : 'observation row not found on read-back' };
    }

    let population;
    if (signal === 'caa') {
      population = await collectAncestors(domain, factsRow, {});
    }

    const qualityRes = await persist({
      signal,
      facts: factsRow,
      runId: crypto.randomUUID(),
      runLabel: `ONDEMAND-QUALITY-${signal.toUpperCase()}-${domain}-${startedAt}`,
      sourceRunId: collectionRes.run.id,
      population,
    }, { client });

    return summariseQualityOutcome(signal, qualityRes);
  }

  // 4 — TLS + Certificate as one shared step (ADR-COL-003: one handshake
  // feeds two canonical Observations under two Collection Runs).
  async function runTlsAndCertificate() {
    const runLabel = `ONDEMAND-TLSCERT-${domain}-${startedAt}`;
    let res;
    try {
      res = await runTlsCertificate({ domains: [domain], runLabel }, client);
    } catch (err) {
      return [
        { signal: 'tls', observed: false, scored: false, error: err.message },
        { signal: 'certificate', observed: false, scored: false, error: err.message },
      ];
    }

    const result = res.results && res.results[0];
    const targets = [
      ['tls', 'signal_tls_v1', res.tls && res.tls.run, 'tlsError'],
      ['certificate', 'signal_certificate_v1', res.certificate && res.certificate.run, 'certError'],
    ];

    const out = [];
    for (const [signal, tableName, runObj, errKey] of targets) {
      if (!result || result[errKey] || !runObj) {
        out.push({ signal, observed: false, scored: false, error: (result && result[errKey]) || 'no observation produced' });
        continue;
      }
      const { data: factsRow, error: readErr } = await readPersistedFacts(
        { tableName, domain, collectionRunId: runObj.id }, client,
      );
      if (readErr || !factsRow) {
        out.push({ signal, observed: true, scored: false, error: readErr ? readErr.message : 'observation row not found on read-back' });
        continue;
      }
      const qualityRes = await persist({
        signal, facts: factsRow,
        runId: crypto.randomUUID(),
        runLabel: `ONDEMAND-QUALITY-${signal.toUpperCase()}-${domain}-${startedAt}`,
        sourceRunId: runObj.id,
      }, { client });
      out.push(summariseQualityOutcome(signal, qualityRes));
    }
    return out;
  }

  let signalResults;
  try {
    const [resilientResults, tlsCertResults] = await Promise.all([
      Promise.all(RESILIENT_SESSION_SIGNALS.map(runOneSignal)),
      runTlsAndCertificate(),
    ]);
    signalResults = [...resilientResults, ...tlsCertResults];
  } catch (err) {
    await transition(session.id, 'failed', { note: err.message }, client);
    return { ok: false, error: err.message, sessionId: session.id };
  }

  // 5 — Truthful session completion. The session itself reaches 'completed'
  // once the pipeline has run end to end for every signal — individual
  // signal-level failures are expected, honestly recorded per-signal above
  // (and, independently, in each signal's own collection_runs terminal
  // state), never escalated into a session-level failure. The Observation
  // Session state machine (observation-session.js) has no 'partial' status;
  // that finer-grained truthfulness already lives one layer down, at the
  // Collection Run level (migration 042), which this module does not
  // duplicate. 'failed' is reserved for a systemic pipeline exception
  // (caught above), not for a subset of signals not scoring.
  const signalsObserved = signalResults.filter((r) => r.observed).length;
  const signalsScored = signalResults.filter((r) => r.scored).length;
  const signalsFailed = signalResults.filter((r) => !r.observed).length;

  await transition(session.id, 'completed', {
    metadata: {
      organisationId, resolutionOutcome: resolution.outcome,
      signalsObserved, signalsScored, signalsFailed, signalsTotal: signalResults.length,
    },
  }, client);

  return {
    ok: true,
    sessionId: session.id,
    organisationId,
    resolutionOutcome: resolution.outcome,
    signals: signalResults,
  };
}

function summariseQualityOutcome(signal, qualityRes) {
  if (!qualityRes.ok) {
    return { signal, observed: true, scored: false, error: qualityRes.error };
  }
  if (!qualityRes.persisted) {
    return { signal, observed: true, scored: false, reason: qualityRes.result.reason };
  }
  return { signal, observed: true, scored: true, score: qualityRes.result.score };
}

module.exports = { runOnDemandObservation, RESILIENT_SESSION_SIGNALS };
