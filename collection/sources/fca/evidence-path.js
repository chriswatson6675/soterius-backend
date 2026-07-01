'use strict';

// evidence-path.js — pure path helpers for the FCA Preserve sink.
//
// Reference Collector v0.1 — PHASE 4 (IMP-FCA-001 §4).
//
// Pure functions only: no I/O, no meaning. Decides the on-disk layout of an
// append-only, run-stamped evidence directory (mirrors the Companies House sink):
//
//   runs/<runId>/
//     manifest.json              run/collection metadata (manifest.js)
//     raw/<endpointId>.ndjson    one append-only JSON line per observed page
//
// Authority: CCS-FCA-001 §0.2/§15 (properties not technology); IMP-FCA-001 §0.3/§4.

const path = require('node:path');

/** Make an endpoint id safe to use as a filename (FCA ids use dots; keep them). */
function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function runDir(root, runId) { return path.join(root, String(runId)); }
function rawDir(dir) { return path.join(dir, 'raw'); }
function rawFileFor(dir, endpointId) { return path.join(rawDir(dir), safeName(endpointId) + '.ndjson'); }
function manifestPath(dir) { return path.join(dir, 'manifest.json'); }

module.exports = { safeName, runDir, rawDir, rawFileFor, manifestPath };
