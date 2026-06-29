'use strict';

// report.js — operational reporting for a completed SRA Collection Package.
//
// SRA Snapshot Collector v0.1 — Reporting layer (read-only).
//
// Produces four operational reports — collection, coverage, health, discoveries —
// from the package's PERSISTED artefacts only (via snapshot-run-model.js). It
// describes the COLLECTION PROCESS and package state; it never interprets the
// evidence, derives benchmarking, or scores organisations. Source-specific metadata
// is injected via a report profile (sra-report-profile.js); the generic builders
// here carry no source knowledge.
//
// `generateReports` is strictly READ-ONLY (returns report objects, writes nothing).
// `writeReports` is an explicit convenience that writes the reports into the
// package's dedicated `reports/` output directory — it touches NO evidence artefact
// (raw / structured / provenance / manifest / SEALED are never modified).

const fs = require('node:fs');
const path = require('node:path');

const { reportsDir } = require('./evidence-path');
const { loadRunModel } = require('./snapshot-run-model');
const { buildCoverage, integrityStatusOf } = require('./coverage');
const { SRA_REPORT_PROFILE } = require('./sra-report-profile');

const REQUIRED_FOR_HEALTH = ['manifest', 'rawIndex', 'structured', 'provenance'];

// ── collection (process) report ────────────────────────────────────────────────
function buildCollectionReport(model, profile) {
  const m = model.manifest || {};
  const segmentsDeclared = m.segmentCount ?? (Array.isArray(m.segments) ? m.segments.length : null);
  return {
    reportType: 'collection-report',
    note: 'Describes the collection process. Does NOT summarise or interpret the evidence.',
    sourceId: profile.sourceId,
    sourceAuthority: profile.sourceAuthority ?? null,
    serviceLabel: profile.serviceLabel ?? null,
    runId: m.runId ?? null,
    collectorVersion: m.collectorVersion ?? null,
    collection: { startedAt: m.collectionStartedAt ?? null, completedAt: m.collectionCompletedAt ?? null },
    snapshotProductionTimestamp: m.snapshotProductionTimestamp ?? null,
    segments: { declared: segmentsDeclared, indexed: model.rawIndexPresent ? model.rawIndex.length : null, totalBytes: m.totalBytes ?? null },
    structuredRecords: model.structured.recordCount,
    provenanceRecords: model.provenance.lineageCount,
    sealed: model.sealed,
  };
}

// ── health (engineering-operations) report ────────────────────────────────────────
function genericAnomalies(model) {
  const out = [];
  for (const k of REQUIRED_FOR_HEALTH) if (!model.artefacts[k]) out.push({ code: 'missing-artefact', detail: `${k} missing` });
  if (!model.artefacts.sealed) out.push({ code: 'not-sealed', detail: 'package is not sealed' });

  const m = model.manifest || {};
  const declared = m.segmentCount ?? (Array.isArray(m.segments) ? m.segments.length : null);
  const indexed = model.rawIndexPresent ? model.rawIndex.length : null;
  if (declared != null && indexed != null && declared !== indexed) out.push({ code: 'segment-count-mismatch', detail: `manifest ${declared} vs index ${indexed}` });

  const ist = integrityStatusOf(model.integrity);
  if (ist.ok === false) out.push({ code: 'integrity-failed', detail: 'integrity verification failed' });
  if (model.integrity && model.integrity.rawHashes && model.integrity.rawHashes.verified !== model.integrity.rawHashes.checked) {
    out.push({ code: 'raw-hash-failure', detail: 'one or more raw segments failed hash verification' });
  }
  if (model.structured.unrecognised.length > 0) out.push({ code: 'unrecognised-structures', detail: `${model.structured.unrecognised.length} unrecognised structure(s)` });
  return out;
}

function buildHealthReport(model, profile) {
  const m = model.manifest || {};
  const anomalies = [...genericAnomalies(model), ...((profile.anomalies && profile.anomalies(model)) || [])];
  return {
    reportType: 'health-report',
    note: 'Engineering operations only. Says nothing about organisational trust.',
    sourceId: profile.sourceId,
    runId: m.runId ?? null,
    sealed: model.sealed,
    integrity: integrityStatusOf(model.integrity),
    anomalies,
    artefacts: { ...model.artefacts },
  };
}

// ── discoveries report (unrecognised structures preserved during extraction) ────────
function buildDiscoveriesReport(model, profile) {
  return {
    reportType: 'discoveries-report',
    note: 'Unrecognised structures preserved verbatim during extraction (lossless fallback).',
    sourceId: profile.sourceId,
    runId: model.manifest ? (model.manifest.runId ?? null) : null,
    count: model.structured.unrecognised.length,
    discoveries: model.structured.unrecognised,
  };
}

// ── orchestration ──────────────────────────────────────────────────────────────────

/**
 * Generate all reports for a package. READ-ONLY: returns objects, writes nothing.
 * @param {string} runDir
 * @param {Object} [opts] - { profile, integrity }
 */
function generateReports(runDir, opts = {}) {
  const profile = opts.profile || SRA_REPORT_PROFILE;
  const model = loadRunModel(runDir, { integrity: opts.integrity });
  return {
    collection: buildCollectionReport(model, profile),
    coverage: buildCoverage(model, profile),
    health: buildHealthReport(model, profile),
    discoveries: buildDiscoveriesReport(model, profile),
  };
}

/**
 * Write the reports into the package's `reports/` output directory. Touches NO
 * evidence artefact. Returns the report objects.
 */
function writeReports(runDir, opts = {}) {
  const reports = generateReports(runDir, opts);
  const dir = reportsDir(runDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'collection-report.json'), JSON.stringify(reports.collection, null, 2));
  fs.writeFileSync(path.join(dir, 'coverage-report.json'), JSON.stringify(reports.coverage, null, 2));
  fs.writeFileSync(path.join(dir, 'health-report.json'), JSON.stringify(reports.health, null, 2));
  fs.writeFileSync(path.join(dir, 'discoveries-report.json'), JSON.stringify(reports.discoveries, null, 2));
  return reports;
}

module.exports = {
  generateReports, writeReports,
  buildCollectionReport, buildHealthReport, buildDiscoveriesReport,
};
