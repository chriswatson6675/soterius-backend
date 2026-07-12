'use strict';

// Organisation History — a READ-MODEL projection over canonical Observations
// (OBS-CONST-001 §3: "a projection ... is a persistence-layer mechanism, not
// itself a constitutional object. It has no independent standing; it is only ever
// a lens onto the [observations] that actually happened").
//
// Sprint 11 of the ADR-SYS-009 implementation programme. This module:
//   * stores NOTHING and owns NOTHING — there is no history table, no cache;
//   * is always reproducible from Observations — every call re-reads them;
//   * contains NO Quality Model output, score, band, or Trust Profile — it
//     surfaces only evidence (the collectors' payload) and the Observation
//     envelope (collector / programme / run / timestamp / outcome).
//
// It is derived from the per-signal Observation tables (signal-registry.js),
// filtered by organisation_id. Observations remain authoritative; Repository
// Authority remains authoritative for identity. History invents neither.

const { OBSERVATORY_SIGNALS } = require('../collection/signal-registry');
const eventStore = require('../events/event-store');
const registry = require('../events/subject-registry');

// Envelope + plumbing columns. Surfaced at the entry level (collector, run,
// programme, timestamp, outcome, domain) or irrelevant to evidence (id,
// created_at, organisation linkage, legacy run_id) — stripped from observedFacts
// so the facts are the signal's own payload only.
const ENVELOPE_AND_PLUMBING = new Set([
  'id', 'created_at', 'collected_at', 'domain',
  'collection_run_id', 'collection_programme_id',
  'collector', 'collector_version', 'collection_method', 'collection_outcome',
  'organisation_id', 'repository_authority_ref', 'run_id',
]);

function toEntry(signal, row) {
  const observedFacts = {};
  for (const [k, v] of Object.entries(row)) {
    if (!ENVELOPE_AND_PLUMBING.has(k)) observedFacts[k] = v;
  }
  return {
    observationId: row.id ?? null,
    domain: row.domain ?? null,
    collector: row.collector ?? signal.collector,
    collectorVersion: row.collector_version ?? null,
    collectionProgrammeId: row.collection_programme_id ?? null,
    collectionRunId: row.collection_run_id ?? null,
    collectedAt: row.collected_at ?? null,
    collectionOutcome: row.collection_outcome ?? null,
    observedFacts,
  };
}

// Deterministic TOTAL order: chronological by collectedAt, then collector, then
// observationId — stable even when timestamps and/or signals coincide, so two
// projections of the same Observations are byte-identical.
function chronological(a, b) {
  if (a.collectedAt !== b.collectedAt) return String(a.collectedAt) < String(b.collectedAt) ? -1 : 1;
  if (a.collector !== b.collector) return a.collector < b.collector ? -1 : 1;
  return String(a.observationId) < String(b.observationId) ? -1 : 1;
}

// buildOrganisationHistory(organisationId, { client, signals }) →
//   { organisationId, observationCount, signalsObserved, firstObservedAt,
//     lastObservedAt, entries: [...chronological] }
//
// Only Observations linked to this organisation appear — organisation_id NULL
// (unresolved) observations are excluded by construction (the equality filter).
async function buildOrganisationHistory(organisationId, { client, signals = OBSERVATORY_SIGNALS } = {}) {
  const empty = (id) => ({
    organisationId: id ?? null, observationCount: 0, signalsObserved: [],
    firstObservedAt: null, lastObservedAt: null, entries: [],
  });

  // A missing/unresolved id has no history by construction — never a projection
  // over NULL-linked observations.
  if (!organisationId) return empty(organisationId);
  if (!client) throw new Error('a database client is required');

  const perSignal = await Promise.all(signals.map(async (signal) => {
    const { data, error } = await client.from(signal.table).select('*').eq('organisation_id', organisationId);
    if (error) throw new Error(`Organisation History read failed for ${signal.table}: ${error.message}`);
    return (data ?? []).map((row) => toEntry(signal, row));
  }));

  const entries = perSignal.flat().sort(chronological);
  if (entries.length === 0) return empty(organisationId);

  return {
    organisationId,
    observationCount: entries.length,
    signalsObserved: [...new Set(entries.map((e) => e.collector))].sort(),
    firstObservedAt: entries[0].collectedAt,
    lastObservedAt: entries[entries.length - 1].collectedAt,
    entries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event projection — the completed Organisation History.
//
// The observation-only projection above is a lens over Observations alone. The
// Event projection below folds the full Event stream (Observations, Repository
// Decisions, Repository Changes) through the Subject Registry — the temporal
// substrate OBS-CONST-001 §3 requires ("computed from ... Events"). It remains
// a pure projection: stores nothing, owns nothing, re-reads Events on every
// call, and is deterministic. It NEVER switches on subject_type itself — every
// subject is resolved through registry.readSubject. Unresolved references are
// surfaced honestly (resolved:false + reason), never fabricated (Unknown ≠ Absent).
// asOf bounds the fold by occurred_at (valid time), which is how a historical
// Organisation view is derived without touching the past.

// Default subject resolvers, injected into the registry per event. The registry
// dispatches on subject_type; these say HOW to read each subject's fact. Only
// the Observation store is materialised today; Repository Decision/Change
// resolvers are omitted, so those subjects surface as honest references
// (the registry's built-in pending-store behaviour).
async function resolveObservationByRun(collectionRunId, ctx) {
  const { client, organisationId, signals = OBSERVATORY_SIGNALS } = ctx;
  if (!client || !organisationId || !collectionRunId) return null;

  const perSignal = await Promise.all(signals.map(async (signal) => {
    const { data, error } = await client
      .from(signal.table)
      .select('*')
      .eq('organisation_id', organisationId)
      .eq('collection_run_id', collectionRunId);
    if (error) throw new Error(`Observation resolution failed for ${signal.table}: ${error.message}`);
    return (data ?? []).map((row) => toEntry(signal, row));
  }));

  const observations = perSignal.flat().sort(chronological);
  return observations.length ? { collectionRunId, observationCount: observations.length, observations } : null;
}

// Total, reproducible order: by occurred_at, then event_id — stable so two
// projections of the same Events are identical.
function eventOrder(a, b) {
  if (a.occurred_at !== b.occurred_at) return String(a.occurred_at) < String(b.occurred_at) ? -1 : 1;
  return String(a.event_id) < String(b.event_id) ? -1 : 1;
}

// projectOrganisationHistory(organisationId, { asOf, client, resolvers }) →
//   { organisationId, asOf, eventCount, unresolvedCount, entries: [...chronological] }
//
// Each entry is the Event envelope + the resolved subject (or an honest
// unresolved reference). Nothing is stored; every call re-derives from Events.
async function projectOrganisationHistory(organisationId, { asOf = null, client, resolvers = {} } = {}) {
  const empty = (id) => ({ organisationId: id ?? null, asOf, eventCount: 0, unresolvedCount: 0, entries: [] });
  if (!organisationId) return empty(organisationId);
  if (!client) throw new Error('a database client is required');

  const streamResult = await eventStore.listEventsForOrganisation(organisationId, { asOf }, client);
  if (!streamResult.ok) throw new Error(`Organisation History event read failed: ${streamResult.error}`);
  const events = [...streamResult.events].sort(eventOrder);
  if (events.length === 0) return empty(organisationId);

  const entries = [];
  let unresolvedCount = 0;
  for (const ev of events) {
    // Every subject resolves EXCLUSIVELY through the registry — the projection
    // never dispatches on subject_type itself. The event's own organisation_id
    // and injected resolvers are handed to the reader via ctx.
    const resolution = await registry.readSubject(ev.subject_type, ev.subject_id, {
      client,
      organisationId: ev.organisation_id,
      resolveObservation: resolvers.resolveObservation || resolveObservationByRun,
      resolveRepositoryDecision: resolvers.resolveRepositoryDecision,
      resolveRepositoryChange: resolvers.resolveRepositoryChange,
    });
    if (!resolution.resolved) unresolvedCount += 1;
    entries.push({
      occurredAt: ev.occurred_at,
      recordedAt: ev.recorded_at,
      subjectType: ev.subject_type,
      subjectId: ev.subject_id,
      repositoryAuthorityVersion: ev.repository_authority_version ?? null,
      qualityModelVersion: ev.quality_model_version ?? null,
      resolved: resolution.resolved,
      subject: resolution.resolved ? (resolution.subject ?? null) : null,
      reference: resolution.resolved ? null : { reason: resolution.reason ?? 'unresolved' },
      metadata: ev.metadata ?? {},
    });
  }

  return {
    organisationId,
    asOf,
    eventCount: events.length,
    unresolvedCount,
    entries,
  };
}

module.exports = {
  buildOrganisationHistory,       // observation-only lens (retained)
  projectOrganisationHistory,      // Event projection — the completed history
  resolveObservationByRun,
  OBSERVATORY_SIGNALS,
};
