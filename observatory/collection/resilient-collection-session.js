'use strict';

// resilient-collection-session.js — production-hardening executor (Blockers 2–4).
//
// This is the production-grade orchestration path for a national Collection Run.
// It is NOT a redesign of the Collection Session: it reuses the SAME canonical
// primitives runCollectionSession uses (registry programme/run, the Organisation
// Resolver, each signal adapter's collect + buildObservation), and produces the
// SAME canonical Observations. What it adds around them is operational hardening:
//
//   • RETRY (Blocker 2)   — every collect() runs through the retry engine, which
//                           retries transient failures with exponential backoff
//                           and stops immediately on permanent/unexpected ones.
//   • LIFECYCLE (Blocker 3) — the run finishes in a TRUTHFUL terminal state
//                           (COMPLETED / PARTIAL / FAILED / CANCELLED) derived
//                           from the real per-organisation outcome, with a
//                           completion summary (coverage %, counts, failure
//                           breakdown).
//   • RESUME (Blocker 4)  — progress is persisted to the operational ledger, so a
//                           restarted run continues where it stopped: completed
//                           organisations are never recollected, and duplicate
//                           Observations are never written.
//
// EVIDENCE INTEGRITY (constitutional): Observations remain immutable and are only
// ever INSERTed, never updated or deleted. Retry/lifecycle/progress state lives on
// OPERATIONAL objects (collection_runs, collection_run_items) — never on evidence.
// The run's identity (id / programme_id / run_label / started_at) is immutable;
// only its status/summary move. This module mutates no Observation. It DOES
// append a Constitutional Event (OBS-CONST-001 §4) on each freshly-persisted
// Observation, via the sanctioned emitter (observatory/events/emitters.js) —
// best-effort and non-blocking, so an Event-write failure never fails the run;
// see processDomain below for the exact call site and its idempotency rule.

const registry = require('./registry');
const ledgerModule = require('./progress-ledger');
const { withRetry } = require('./retry-engine');
const { classifyFailure } = require('./failure-classifier');
const { deriveTerminalState, coveragePct } = require('./run-lifecycle');
const emitters = require('../events/emitters');
const logger = require('../../infra/utils/logger');

function getClient() { return require('../../infra/database').getClient(); }

function defaultResolveOrganisation(domain) {
  return require('../../organisation/resolve').resolveOrganisationByDomain(domain);
}

// findResumableRun — locate a prior, still-RUNNING run for this programme +
// run_label to resume. A run in any terminal state is NOT resumed (it is finished
// evidence); a fresh execution of the same label opens a new run with a new
// identity, whose Observations are distinct evidence, not duplicates.
async function findResumableRun(programmeId, runLabel, listRuns, client) {
  const runs = await listRuns(programmeId, client);
  return (runs || []).find((r) => r.run_label === runLabel && r.status === 'RUNNING') || null;
}

// runResilientCollectionSession({ runLabel, domains, adapter, deps, options })
//
// Returns { programme, run, summary, observations, resumed }.
//   summary = { state, intended, succeeded, failed, outstanding, coveragePct, byFailureClass }
async function runResilientCollectionSession({ runLabel, domains, adapter, deps = {}, options = {} }) {
  if (!adapter) throw new Error('a signal adapter is required');
  if (!adapter.tableName) throw new Error('adapter.tableName is required');
  if (!adapter.programme || !adapter.programme.key) throw new Error('adapter.programme.key is required');
  if (!runLabel) throw new Error('runLabel is required');
  if (!Array.isArray(domains) || domains.length === 0) throw new Error('domains must be a non-empty array');

  const {
    upsertProgramme = registry.upsertProgramme,
    openRun = registry.openRun,
    transitionRun = registry.transitionRun,
    listRunsForProgramme = registry.listRunsForProgramme,
    collect = adapter.collect,
    buildObservation = adapter.buildObservation,
    persistChildren = adapter.persistChildren,
    resolveOrganisation = defaultResolveOrganisation,
    ledger = ledgerModule,
    classify = classifyFailure,
    client = getClient(),
    now,
    sleep, // injectable retry sleep (tests)
  } = deps;

  const {
    concurrency = 8,
    maxAttempts,       // undefined → retry engine reads env / defaults
    baseDelayMs,
    resume = true,
    shouldCancel,      // optional () => boolean, checked between organisations
  } = options;

  if (typeof collect !== 'function') throw new Error('adapter.collect (or deps.collect) must be a function');
  if (typeof buildObservation !== 'function') throw new Error('adapter.buildObservation (or deps.buildObservation) must be a function');

  const timestamp = () => (now ? now() : new Date().toISOString());
  const uniqueDomains = [...new Set(domains.filter(Boolean))];
  const intended = uniqueDomains.length;

  // 1 ── Programme (idempotent).
  const p = adapter.programme;
  const progRes = await upsertProgramme(
    { key: p.key, name: p.name, kind: p.kind ?? 'NATIONAL', signal: p.signal ?? null },
    client,
  );
  if (!progRes.success) throw new Error(`programme upsert failed: ${progRes.error}`);
  const programme = progRes.programme;

  // 2 ── Run: resume an interrupted one, or open a new one.
  let run = null;
  let resumed = false;
  if (resume) {
    run = await findResumableRun(programme.id, runLabel, listRunsForProgramme, client);
    if (run) resumed = true;
  }
  if (!run) {
    const runRes = await openRun(
      { programmeId: programme.id, runLabel, metadata: { domain_count: intended } },
      client,
    );
    if (!runRes.success) throw new Error(`run open failed: ${runRes.error}`);
    run = runRes.run;
  }

  // 3 ── Ledger: create items (idempotent — a resumed run keeps its progress),
  //      then compute the outstanding work-list. Completed organisations are
  //      absent from it and thus never recollected.
  await ledger.initItems(run.id, uniqueDomains, client);
  const work = await ledger.outstandingDomains(run.id, client);

  const observations = [];
  let cancelled = false;
  let nextIndex = 0;

  async function existingObservationId(domain) {
    // Duplicate-prevention guard for the crash window between INSERT and ledger
    // markCompleted: if this run already has an Observation for this domain,
    // adopt it instead of writing a second one.
    const { data } = await client
      .from(adapter.tableName)
      .select('id')
      .eq('collection_run_id', run.id)
      .eq('domain', domain)
      .limit(1)
      .maybeSingle();
    return data ? data.id : null;
  }

  async function processDomain(domain) {
    if (shouldCancel && shouldCancel()) { cancelled = true; return; }
    await ledger.markRunning(run.id, domain, null, client);

    // Idempotency guard first — never write a duplicate Observation on resume.
    try {
      const existingId = await existingObservationId(domain);
      if (existingId) {
        await ledger.markCompleted(run.id, domain, { observationId: existingId }, client);
        observations.push({ domain, id: existingId, adopted: true });
        return;
      }
    } catch { /* guard is best-effort; fall through to a fresh collect */ }

    // Collect with retry (transient failures only).
    const retryRes = await withRetry(() => collect(domain), { maxAttempts, baseDelayMs, sleep, classify });

    if (!retryRes.ok) {
      const cls = retryRes.classification;
      const permanent = cls && (cls.class === 'PERMANENT' || cls.class === 'UNEXPECTED');
      await ledger.markFailed(run.id, domain, {
        failureClass: cls ? cls.class : 'UNEXPECTED',
        error: retryRes.error ? retryRes.error.message : 'unknown',
        attempts: retryRes.attempts,
        permanent,
      }, client);
      observations.push({ domain, error: retryRes.error?.message ?? 'unknown', failureClass: cls?.class, attempts: retryRes.attempts });
      return;
    }

    const facts = retryRes.value;

    // Resolve the Organisation (only RESOLVED links; never a guess). A resolver
    // failure never blocks collection — the Observation persists unlinked.
    let organisationId = null;
    let repositoryAuthorityRef = null;
    try {
      const res = resolveOrganisation(domain);
      if (res && res.outcome === 'RESOLVED') {
        organisationId = res.organisationId;
        repositoryAuthorityRef = `authority@${res.provenance?.authorityVersion ?? 'unknown'}`;
      }
    } catch { /* leave unlinked */ }

    const observedAt = timestamp();
    let row;
    try {
      row = buildObservation({ domain, facts, run, observedAt, organisationId, repositoryAuthorityRef });
    } catch (buildErr) {
      // A build error is an UNEXPECTED (code) failure — record it, do not retry.
      await ledger.markFailed(run.id, domain, { failureClass: 'UNEXPECTED', error: buildErr.message, attempts: retryRes.attempts, permanent: true }, client);
      observations.push({ domain, error: buildErr.message, failureClass: 'UNEXPECTED' });
      return;
    }

    const { data, error } = await client.from(adapter.tableName).insert([row]).select('id').single();
    if (error) {
      // Persistence failure — an infrastructure fault. Record as FAILED (not
      // permanent) so a resume retries it; the Observation was NOT written.
      await ledger.markFailed(run.id, domain, { failureClass: 'UNEXPECTED', error: error.message, attempts: retryRes.attempts }, client);
      observations.push({ domain, error: error.message, failureClass: 'UNEXPECTED' });
      return;
    }

    // Child rows (e.g. DKIM keys). Parent is already persisted; a child failure is
    // recorded but does not fail the organisation.
    let childError = null;
    if (persistChildren) {
      try { await persistChildren({ observationId: data.id, domain, facts, run, observedAt, client }); }
      catch (childErr) { childError = childErr.message; }
    }

    await ledger.markCompleted(run.id, domain, { observationId: data.id, attempts: retryRes.attempts }, client);

    // Constitutional Event (OBS-CONST-001 §4) — mark the completion of
    // Observation persistence. Best-effort and non-blocking: the Observation is
    // already durably inserted, which is the evidence of record — Evidence
    // Preservation outranks Event bookkeeping, so a failure here is logged and
    // swallowed, never thrown, and never affects the run's terminal state. No
    // score, band, or Quality Model output is attached (interpretation runs
    // downstream, separately, never here). organisationId may be null
    // (Unknown ≠ Absent): the Event still records that persistence happened
    // even when the Organisation is not yet known.
    //
    // Deliberately emitted ONLY on this fresh-insert path — the resume/
    // idempotency "adopt an existing Observation" path above (existingObservationId)
    // does NOT emit, so a resumed run never double-emits an Event for an
    // Observation it did not just create. recordEvent has no idempotency key, so
    // guarding at the call site is how a duplicate Event is avoided.
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

    const rec = { domain, id: data.id, attempts: retryRes.attempts };
    if (childError) rec.childError = childError;
    observations.push(rec);
  }

  // 4 ── Concurrency pool over the outstanding work-list.
  const workerCount = Math.max(1, Math.min(concurrency, work.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < work.length) {
      if (cancelled) return;
      const i = nextIndex++;
      await processDomain(work[i]);
    }
  }));

  // 5 ── Truthful terminal state from the ledger (authoritative across resumes:
  //      counts include organisations completed in earlier attempts of this run).
  const c = await ledger.counts(run.id, client);
  const state = deriveTerminalState({
    intended,
    succeeded: c.completed,
    failed: c.failedTotal,
    cancelled,
  });
  const summary = {
    state,
    intended,
    succeeded: c.completed,
    failed: c.failedTotal,
    outstanding: Math.max(0, intended - c.completed - c.failedTotal),
    coveragePct: coveragePct(c.completed, intended),
    byFailureClass: c.byFailureClass,
  };

  const termRes = await transitionRun(
    run.id, 'RUNNING', state,
    {
      metadata: { domain_count: intended, ...summary },
      summary: { intended, succeeded: c.completed, failed: c.failedTotal, coveragePct: summary.coveragePct },
    },
    client,
  );

  return {
    programme,
    run: termRes.success ? termRes.run : run,
    summary,
    observations,
    resumed,
  };
}

module.exports = { runResilientCollectionSession, findResumableRun };
