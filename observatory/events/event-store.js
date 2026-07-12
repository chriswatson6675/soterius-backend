'use strict';

// event-store.js — append-only access to the Event log (OBS-CONST-001 §3, P-3/P-4).
//
// This module offers exactly two operations: record (append) and read. There is
// no update and no delete, by design — the Event is immutable and append-only.
// The database enforces the same guarantee (migration 040 blocks UPDATE/DELETE
// with a trigger); this module simply never offers a way to attempt one.
//
// Every recorded Event is validated against the governed subject registry — the
// Event owns no domain semantics, so its only real invariant is "references an
// admitted constitutional subject."

const { getClient } = require('../../infra/database');
const registry = require('./subject-registry');

/**
 * Append an Event. Validates subject_type via the registry; sets recorded_at to
 * now unless supplied. Never overwrites — append only.
 *
 * @param {Object} e
 * @param {string} e.subjectType                    - an admitted constitutional subject
 * @param {string} e.subjectId
 * @param {string} [e.organisationId]               - canonical ORG-*; null while unresolved
 * @param {string} e.occurredAt                     - ISO; when it happened / became true (valid time)
 * @param {string} [e.recordedAt]                   - ISO; defaults to now (knowledge time)
 * @param {string} [e.repositoryAuthorityVersion]
 * @param {string} [e.qualityModelVersion]
 * @param {Object} [e.metadata]
 */
async function recordEvent(e, client = getClient()) {
  if (!registry.isValidSubjectType(e.subjectType)) {
    const reason = registry.rejectionReason(e.subjectType);
    return { ok: false, error: reason ? `subject_type '${e.subjectType}' not admitted: ${reason}` : `unknown subject_type '${e.subjectType}'` };
  }
  if (!e.subjectId) return { ok: false, error: 'subjectId is required' };
  if (!e.occurredAt) return { ok: false, error: 'occurredAt is required' };

  const row = {
    subject_type: e.subjectType,
    subject_id: e.subjectId,
    organisation_id: e.organisationId ?? null,
    occurred_at: e.occurredAt,
    recorded_at: e.recordedAt ?? new Date().toISOString(),
    repository_authority_version: e.repositoryAuthorityVersion ?? null,
    quality_model_version: e.qualityModelVersion ?? null,
    metadata: e.metadata ?? {},
  };

  const { data, error } = await client
    .from('events')
    .insert([row])
    .select('*')
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, event: data };
}

/**
 * The Organisation's time-ordered Event stream — the primitive the Organisation
 * History projection folds. `asOf` bounds it by occurred_at (valid time), which
 * is how a historical Organisation view is derived without touching the past.
 *
 * @param {string} organisationId - canonical ORG-*
 * @param {Object} [opts]
 * @param {string} [opts.asOf]     - ISO; only events with occurred_at <= asOf
 * @param {number} [opts.limit]
 */
async function listEventsForOrganisation(organisationId, { asOf, limit = 500 } = {}, client = getClient()) {
  if (!organisationId) return { ok: true, events: [] }; // no org, no history — never a scan over NULL-linked events
  let q = client
    .from('events')
    .select('*')
    .eq('organisation_id', organisationId)
    .order('occurred_at', { ascending: true })
    .limit(limit);
  if (asOf) q = q.lte('occurred_at', asOf);
  const { data, error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true, events: data ?? [] };
}

/** Single event by id (read-only). */
async function getEvent(eventId, client = getClient()) {
  const { data, error } = await client
    .from('events')
    .select('*')
    .eq('event_id', eventId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: `event ${eventId} not found` };
  return { ok: true, event: data };
}

module.exports = { recordEvent, listEventsForOrganisation, getEvent };
