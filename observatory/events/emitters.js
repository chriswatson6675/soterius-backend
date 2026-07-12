'use strict';

// emitters.js — the sanctioned Event emission points.
//
// Events are NOT emitted from arbitrary code. Emission happens ONLY through the
// three functions below, each bound to a constitutional lifecycle point named by
// OBS-CONST-001 (§4 lifecycle). This keeps emission auditable and prevents raw
// recordEvent() calls scattering domain semantics into event creation.
//
// Each emitter is a thin, named wrapper over the append-only event store; it
// owns no domain logic beyond choosing the subject_type for its lifecycle point.
//
// The three constitutional emission points:
//
//   1. emitObservationRecorded  — a Collection Run has finished persisting
//      observations for an organisation. Call site: the completion of
//      observation persistence (the Observation Session / Collection Run that
//      wrote signal_facts_* rows). subject = Observation; subjectId = the
//      collection_run_id those observations carry.
//
//   2. emitRepositoryDecision   — a Repository Authority Exception has been
//      approved. Call site: the Approval step of Operational Processing
//      (ADR-COL-010 approval gate). subject = RepositoryDecision.
//
//   3. emitRepositoryChange     — an approved change has been APPLIED to
//      Repository Authority (a merge, split, domain reassignment, classification
//      or lifecycle change), producing a new RA version. Call site: the
//      application step that mints the new Repository Authority version.
//      subject = RepositoryChange.

const { recordEvent } = require('./event-store');

/**
 * Constitutional point 1 — completed Observation persistence.
 * @param {Object} e
 * @param {string} e.organisationId
 * @param {string} e.collectionRunId              - the run whose observations were persisted
 * @param {string} e.occurredAt                   - when persistence completed (valid time)
 * @param {string} [e.repositoryAuthorityVersion] - RA version the run was collected against
 * @param {string} [e.qualityModelVersion]        - QM version, so historical trust re-derives faithfully
 * @param {Object} [e.metadata]
 */
async function emitObservationRecorded(e, client) {
  return recordEvent({
    subjectType: 'Observation',
    subjectId: e.collectionRunId,
    organisationId: e.organisationId ?? null,
    occurredAt: e.occurredAt,
    repositoryAuthorityVersion: e.repositoryAuthorityVersion,
    qualityModelVersion: e.qualityModelVersion,
    metadata: e.metadata,
  }, client);
}

/**
 * Constitutional point 2 — an approved Repository Decision.
 * @param {Object} e
 * @param {string} e.organisationId
 * @param {string} e.decisionId                   - the Approval / Exception-resolution record
 * @param {string} e.occurredAt
 * @param {string} [e.repositoryAuthorityVersion]
 * @param {Object} [e.metadata]
 */
async function emitRepositoryDecision(e, client) {
  return recordEvent({
    subjectType: 'RepositoryDecision',
    subjectId: e.decisionId,
    organisationId: e.organisationId ?? null,
    occurredAt: e.occurredAt,
    repositoryAuthorityVersion: e.repositoryAuthorityVersion,
    metadata: e.metadata,
  }, client);
}

/**
 * Constitutional point 3 — an applied Repository Change.
 * @param {Object} e
 * @param {string} e.organisationId
 * @param {string} e.changeRef                    - RA version / remediation-ledger entry the change produced
 * @param {string} e.occurredAt
 * @param {string} e.repositoryAuthorityVersion   - the new RA version this change minted
 * @param {Object} [e.metadata]
 */
async function emitRepositoryChange(e, client) {
  return recordEvent({
    subjectType: 'RepositoryChange',
    subjectId: e.changeRef,
    organisationId: e.organisationId ?? null,
    occurredAt: e.occurredAt,
    repositoryAuthorityVersion: e.repositoryAuthorityVersion,
    metadata: e.metadata,
  }, client);
}

module.exports = { emitObservationRecorded, emitRepositoryDecision, emitRepositoryChange };
