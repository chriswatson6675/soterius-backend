'use strict';

// evidence-path.js — pure path helpers for the SRA snapshot Collection Package.
//
// SRA Snapshot Collector v0.1 — Collection Package foundation (design accepted).
//
// Pure functions only: no I/O, no meaning. Decides the on-disk layout of an
// immutable, run-stamped SRA collection package — the unit a SUCCESSFUL snapshot
// collection produces. Mirrors the FCA sink's properties (immutable, byte-faithful,
// run-stamped) but at SNAPSHOT granularity rather than per-endpoint:
//
//   runs/<runId>/
//     manifest.json              collection-process metadata (manifest.js)
//     raw/                        verbatim, byte-faithful snapshot payload(s)
//       <segment>                 one preserved raw segment, exactly as received
//       raw-index.ndjson          append-only index: one line per preserved segment
//     structured/                 organisational observations (later stage)
//     provenance/                 lineage index (later stage)
//     reports/                    operational reports (later stage)
//     SEALED                      written ONLY on successful completion
//
// Authority: SRA Snapshot Collector design §"Proposed directory structure".

const path = require('node:path');

const PACKAGE_DIRS = Object.freeze(['raw', 'structured', 'provenance', 'reports']);
const RAW_INDEX_FILE = 'raw-index.ndjson';
const SEAL_FILE = 'SEALED';
const MANIFEST_FILE = 'manifest.json';
const DEFAULT_SNAPSHOT_FILE = 'snapshot.json';

/** Make an arbitrary id/name safe to use as a single path segment (snapshot ids can carry ':'). */
function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function runDir(root, runId) { return path.join(root, safeName(String(runId))); }
function rawDir(dir) { return path.join(dir, 'raw'); }
function structuredDir(dir) { return path.join(dir, 'structured'); }
function provenanceDir(dir) { return path.join(dir, 'provenance'); }
function reportsDir(dir) { return path.join(dir, 'reports'); }
function manifestPath(dir) { return path.join(dir, MANIFEST_FILE); }
function sealPath(dir) { return path.join(dir, SEAL_FILE); }
function rawIndexPath(dir) { return path.join(rawDir(dir), RAW_INDEX_FILE); }
function rawSegmentPath(dir, name = DEFAULT_SNAPSHOT_FILE) { return path.join(rawDir(dir), safeName(name)); }

module.exports = {
  PACKAGE_DIRS, RAW_INDEX_FILE, SEAL_FILE, MANIFEST_FILE, DEFAULT_SNAPSHOT_FILE,
  safeName, runDir, rawDir, structuredDir, provenanceDir, reportsDir,
  manifestPath, sealPath, rawIndexPath, rawSegmentPath,
};
