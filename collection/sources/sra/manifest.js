'use strict';

// manifest.js — collection manifest for an SRA snapshot run.
//
// SRA Snapshot Collector v0.1 — Collection Package foundation.
//
// The manifest DESCRIBES the collection PROCESS (identity, versions, timings,
// content hashes, byte/record counts). It MUST NOT summarise or interpret the
// EVIDENCE: it carries operational metadata only — never anything derived from, or
// asserting meaning about, the firms' data. (Mirrors FCA manifest.js [CR-FCA-01].)
//
// Authority: SRA Snapshot Collector design §"Generate manifest".

const fs = require('node:fs');
const { manifestPath } = require('./evidence-path');

const COLLECTOR_VERSION = 'sra-snapshot-collector/0.1.0';
const SOURCE_AUTHORITY = 'Solicitors Regulation Authority';

/**
 * Build a manifest object from run metadata and a preservation tally.
 *
 * @param {Object} [meta]
 * @param {string}      meta.runId
 * @param {string}      [meta.collectorVersion]            defaults to COLLECTOR_VERSION
 * @param {string}      [meta.sourceAuthority]             defaults to SOURCE_AUTHORITY
 * @param {string|null} [meta.collectionStartedAt]         ISO; acquisition start
 * @param {string|null} [meta.collectionCompletedAt]       ISO; acquisition end
 * @param {string|null} [meta.snapshotProductionTimestamp] dataset production time, when available
 * @param {number|null} [meta.recordCount]                 count of preserved records, when known (else null)
 * @param {Object} [preservation] tally from preserve-snapshot ({ segments, segmentCount, totalBytes })
 * @returns {Object} manifest (operational metadata only)
 */
function buildManifest(meta = {}, preservation = {}) {
  const segments = Array.isArray(preservation.segments)
    ? preservation.segments.map((s) => ({ file: s.file, byteLength: s.byteLength, sha256: s.sha256 }))
    : [];
  return {
    artefactType: 'sra-collection-manifest',
    note: 'Describes the collection process. Does NOT summarise or interpret the evidence.',
    runId: meta.runId ?? null,
    collectorVersion: meta.collectorVersion ?? COLLECTOR_VERSION,
    sourceAuthority: meta.sourceAuthority ?? SOURCE_AUTHORITY,
    collectionStartedAt: meta.collectionStartedAt ?? null,
    collectionCompletedAt: meta.collectionCompletedAt ?? null,
    snapshotProductionTimestamp: meta.snapshotProductionTimestamp ?? null,
    segments,
    segmentCount: preservation.segmentCount ?? segments.length,
    totalBytes: preservation.totalBytes ?? segments.reduce((n, s) => n + (s.byteLength || 0), 0),
    recordCount: meta.recordCount ?? null, // unknown until extraction (a later stage) → null
  };
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2));
  return manifestPath(dir);
}

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
}

module.exports = { buildManifest, writeManifest, readManifest, COLLECTOR_VERSION, SOURCE_AUTHORITY };
