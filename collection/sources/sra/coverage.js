'use strict';

// coverage.js — snapshot coverage reporting (read-only, generic over the run model).
//
// SRA Snapshot Collector v0.1 — Reporting layer.
//
// Describes COMPLETENESS only: snapshot completeness (segments declared vs indexed,
// production timestamp present), structured record counts, package completeness
// (required artefacts present + sealed), and integrity status. It NEVER estimates
// missing evidence, derives benchmarking, or scores organisations. Pure function
// over the run model.

/**
 * Normalise an integrity result (a fresh verifyPackage result OR the SEALED marker's
 * embedded summary OR null) into a status. Reads only; computes nothing about the data.
 */
function integrityStatusOf(integrity) {
  if (!integrity) return { status: 'unverified', ok: null, records: null, rawHashes: null };
  const records = integrity.records ?? null;
  const rawHashes = integrity.rawHashes ?? null;
  const recordsOk = records ? records.verified === records.total : null;
  const hashesOk = rawHashes ? rawHashes.verified === rawHashes.checked : null;
  const ok = (typeof integrity.ok === 'boolean')
    ? integrity.ok
    : (recordsOk !== false && hashesOk !== false && (recordsOk === true || hashesOk === true));
  return { status: ok ? 'verified' : 'failed', ok: !!ok, records, rawHashes };
}

const REQUIRED_ARTEFACTS = ['manifest', 'rawIndex', 'structured', 'provenance'];

/**
 * Build the coverage report from a run model.
 * @param {Object} model - from snapshot-run-model.loadRunModel
 * @param {Object} profile - report profile (sourceId)
 */
function buildCoverage(model, profile) {
  const m = model.manifest || {};
  const segmentsDeclared = m.segmentCount ?? (Array.isArray(m.segments) ? m.segments.length : null);
  const segmentsIndexed = model.rawIndexPresent ? model.rawIndex.length : null;
  const segmentsConsistent = segmentsDeclared == null || segmentsIndexed == null || segmentsDeclared === segmentsIndexed;

  const packageComplete = REQUIRED_ARTEFACTS.every((a) => model.artefacts[a]) && model.artefacts.sealed;
  const integrity = integrityStatusOf(model.integrity);
  const coverageComplete = packageComplete && segmentsConsistent && integrity.ok === true;

  return {
    reportType: 'coverage-report',
    note: 'Describes package + observation completeness. Does NOT estimate missing evidence or score organisations.',
    sourceId: profile.sourceId,
    runId: m.runId ?? null,
    snapshot: {
      productionTimestamp: m.snapshotProductionTimestamp ?? null,
      segmentsDeclared,
      segmentsIndexed,
      segmentsConsistent,
    },
    structured: {
      total: model.structured.recordCount,
      byObjectType: model.structured.byObjectType,
      distinctAnchors: model.structured.distinctAnchors,
      unrecognised: model.structured.unrecognised.length,
    },
    package: { artefacts: { ...model.artefacts }, complete: packageComplete },
    integrity,
    coverageComplete,
  };
}

module.exports = { buildCoverage, integrityStatusOf, REQUIRED_ARTEFACTS };
